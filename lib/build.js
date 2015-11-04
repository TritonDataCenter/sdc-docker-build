/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Overview: This module provides 'docker build' support in Triton.
 *
 * There should be very little Triton (or SmartOS) specific code in this module,
 * as those parts are abstracted out through the event and task handlers.
 */

var child_process = require('child_process');
var crypto = require('crypto');
var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var path = require('path');
var net = require('net');
var util = require('util');
var url = require('url');

var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var deepcopy = require('deepcopy');
var dockerFileParser = require('docker-file-parser');
var lazyProperty = require('lazy-property');
var libuuid = require('libuuid');
var minimatch = require('minimatch');
var mkdirp = require('mkdirp');
var once = require('once');

var utils = require('./utils');
var shellparser = require('./shellparser');


var MAX_DOCKERFILE_LENGTH = 10 * 1024 * 1024;  // 10 Mb

function ForbiddenPathException(msg) {
    this.message = msg;
}
util.inherits(ForbiddenPathException, Error);


/**
 * Builder takes a docker context file and creates a docker image.
 *
 * Events emitted:
 *  'end' - fn(err) when build is finished, err indicates success or failure.
 *  'message' - fn(event) for notifying of events that occur during the build.
 *  'task' - fn(event) for requesting external to handle a given task
 *    - 'image_reprovision', to reprovision the vm with the given image
 *    - 'run', which means to run the given cmd inside of the vm
 *    - 'commands_finished', notify build has finished all dockerfile commands
 */
function Builder(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.workDir, 'opts.workDir');
    assert.string(opts.containerRootDir, 'opts.containerRootDir');
    assert.string(opts.contextFilepath, 'opts.contextFilepath');
    assert.optionalString(opts.dockerfile, 'opts.dockerfile');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.uuid, 'opts.uuid');

    // Allow emitting of events.
    EventEmitter.call(this);

    this.workDir = opts.workDir;
    this.containerRootDir = opts.containerRootDir;
    this.contextFilepath = opts.contextFilepath;
    this.dockerfile = opts.dockerfile || 'Dockerfile';
    this.log = opts.log;
    this.zoneUuid = opts.uuid;

    this.contextDir = path.join(this.workDir, 'dockerbuild');
    this.contextExtractDir = path.join(this.contextDir, 'extracted');
    // Generated image layers during build, each entry is map of:
    //   { cmd: Object, image: Object }
    this.layers = [];
    this.onStepFn = null;  // Can override this to perform post-step actions.
    this.realpathCache = {}; // Used to cache realpath lookups.
    this.stepNo = -1; // Command step number.
    this.totalNumSteps = 0;  // Number of dockerfile commands to be run.

    // Docker image format:
    this.image = {
        'architecture': 'amd64',
        'config': {
            'User': '',
            'WorkingDir': ''
        },
        'os': 'linux',
        'parent': null
    };
    this.config = this.image.config;
}

util.inherits(Builder, EventEmitter);

/**
 * Sets (or creates a new) image id.
 */
Builder.prototype.setImageId = function setImageId(id) {
    if (typeof (id) == 'undefined') {
        id = util.format('%s%s', libuuid.create(), libuuid.create());
        id = id.replace(/-/g, '');
    }
    this.image.id = id;
    return id;
};

Builder.prototype.setParentId = function setParentId(id) {
    this.image.parent = id;
    this.config.Image = id;
    return id;
};

Builder.prototype.getShortId = function getShortId(id) {
    if (!id) {
        id = this.image.id;
    }
    id = id || '';
    return id.replace('-', '', 'g').substr(0, 12);
};

/**
 * Returns the docker image id for the final image.
 */
lazyProperty(Builder.prototype, 'finalId', function builder_finalId() {
    var id = util.format('%s%s', libuuid.create(), libuuid.create());
    id = id.replace(/-/g, '');
    return id;
});

Builder.prototype.start = function start() {
    var builder = this;
    var log = builder.log;

    async.waterfall([
        function extract(next) {
            builder.extractContext(next);
        },
        function read(next) {
            builder.readDockerfile(next);
        },
        function parse(dockerfileContents, next) {
            dockerfileContents = String(dockerfileContents);
            log.debug('dockerfileContents: ', dockerfileContents);
            var commands = dockerFileParser.parse(dockerfileContents);
            builder.totalNumSteps = commands.length;
            next(null, commands);
        },
        function process(allCommands, next) {
            log.debug('processing', allCommands.length, 'commands');
            var initialCommands = [];
            var onBuildCommands = [];
            // Separate instructions - store onbuild for later.
            allCommands.forEach(function (cmd) {
                if (cmd.name == 'ONBUILD') {
                    onBuildCommands.push(cmd);
                } else {
                    initialCommands.push(cmd);
                }
            });

            async.waterfall([
                function runInitialCommands(cb) {
                    log.debug('Running %d initial build commands',
                        initialCommands.length);
                    async.eachSeries(initialCommands,
                        builder.step.bind(builder),
                        cb);
                },
                function runOnBuildCommands(cb) {
                    log.debug('Running %d onbuild commands',
                        onBuildCommands.length);
                    async.eachSeries(onBuildCommands,
                        builder.step.bind(builder),
                        cb);
                }
            ], next);
        },
        function addExtras(next) {
            log.debug('addExtras');
            next();
        }
    ], function (err) {
        if (err) {
            log.debug('emitting failure, err: %j', err);
            log.error(err);
        } else {
            log.debug('emitting success');
            builder.emitStdout(util.format('Successfully built %s\n',
                                            builder.getShortId()));
        }
        log.debug('Final image object', builder.image);
        builder.emit('end', err);
    });
};

Builder.prototype.emitError = function emitError(msg) {
    this.log.error(msg);
    this.emitStdout(util.format('ERROR: %s\n', msg));
};

Builder.prototype.emitStdout = function emitStdout(message) {
    var event = {
        type: 'stdout',
        message: message
    };
    this.emit('message', event);
};

Builder.prototype.emitTask = function emitTask(event, callback) {
    this.emit('task', event);
};

Builder.prototype.extractContext = function extractContext(callback) {
    var builder = this;
    var log = builder.log;
    log.debug('Extracting docker context to:', builder.contextExtractDir);

    var event = {
        callback: callback,
        extractDir: builder.contextExtractDir,
        tarfile: builder.contextFilepath,
        type: 'extract_tarfile'
    };
    builder.emitTask(event);
};

Builder.prototype.readDockerfile = function readDockerfile(callback) {
    var dockerfilePath = path.join(this.contextExtractDir, this.dockerfile);
    var stat;
    try {
        stat = fs.statSync(dockerfilePath);
        if (stat.size > MAX_DOCKERFILE_LENGTH) {
            var errorMsg = 'Dockerfile exceeds max length: ' + stat.size;
            callback(new Error(errorMsg));
            return;
        }
        fs.readFile(dockerfilePath, callback);
    } catch (e) {
        callback(e);
    }
};

Builder.prototype.storeImageLayer = function storeImageLayer(cmd) {
    // Docker images use a 256-bit id value, general uuid's are 128-bits.
    var builder = this;

    builder.log.debug('Storing config for buildstep %d, cmd: %j',
                        builder.stepNo, cmd);

    builder.layers.push({
        cmd: cmd,
        image: deepcopy(builder.image)
    });
};

Builder.prototype.checkForCacheHit = function checkForCacheHit(cmd) {
    // TODO: Implement caching.
    return null;
};

Builder.prototype.updateCommandVariables =
function updateCommandVariables(cmd)
{
    var builder = this;
    var env = builder.config.Env || [];

    env = deepcopy(env);
    // Ensure there is always a default PATH env.
    if (!env.some(function (entry) {
        return entry.substr(0, 5) === 'PATH=';
    })) {
        env.push('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    }

    // Update any variable references in the command arguments.
    if (Array.isArray(cmd.args)) {
        cmd.args = cmd.args.map(function (word) {
            return shellparser.processWord(word, env);
        });
    } else if (typeof (cmd.args) === 'string') {
        cmd.args = shellparser.processWord(cmd.args, env);
    } else {
        // Object format.
        Object.keys(cmd.args).forEach(function (key) {
            cmd.args[key] = shellparser.processWord(cmd.args[key], env);
        });
    }
};

Builder.prototype.addConfigMap = function addConfigMap(cmd, propName) {
    var config = this.config;
    if (!config.hasOwnProperty(propName) || config[propName] === null) {
        config[propName] = {};
    }
    var map = config[propName];

    Object.keys(cmd.args).forEach(function (key) {
        map[key] = cmd.args[key];
    });
};

Builder.prototype.addConfigArrayAsMap =
function addConfigArrayAsMap(cmd, propName)
{
    var config = this.config;
    if (!config.hasOwnProperty(propName) || config[propName] === null) {
        config[propName] = {};
    }
    var map = config[propName];

    cmd.args.forEach(function (val) {
        map[val] = {};
    });
};

Builder.prototype.addConfigEnvArray =
function addConfigEnvArray(cmd, propName)
{
    var config = this.config;
    if (!config.hasOwnProperty(propName) || config[propName] === null) {
        config[propName] = [];
    }
    var arr = config[propName];

    // Replace existing key if it exists.
    Object.keys(cmd.args).forEach(function (key) {
        var existingIdx = -1;
        var findExistingFn = function (entry) {
            existingIdx += 1;
            return entry[key.length] === '='
                && entry.substr(0, key.length) === key;
        };
        if (arr.some(findExistingFn)) {
            // There is a an existing match.
            arr[existingIdx] = key + '=' + cmd.args[key];
        } else {
            arr.push(key + '=' + cmd.args[key]);
        }
    });
};

Builder.prototype.cmdAdd = function cmdAdd(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    this.updateCommandVariables(cmd);
    this.addContextToContainer(cmd, {
        allowRemote: (cmd.name === 'ADD'),
        allowDecompression: (cmd.name === 'ADD')
    }, callback);
};

Builder.prototype.cmdCmd = function cmdCmd(cmd, callback) {
    if (typeof (cmd.args) === 'string') {
        cmd.args = ['/bin/sh', '-c', cmd.args];
    } else {
        assert.arrayOfString(cmd.args, cmd.name
            + ' argument should be an array or a string');
    }
    this.config.Cmd = cmd.args.slice();  // a copy
    callback();
};

Builder.prototype.cmdCopy = function cmdCopy(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    // Same as ADD command, but less sugar.
    this.cmdAdd(cmd, callback);
};

Builder.prototype.cmdEntrypoint = function cmdEntrypoint(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    this.config.Entrypoint = cmd.args.slice();  // a copy
    callback();
};

Builder.prototype.cmdEnv = function cmdEnv(cmd, callback) {
    assert.object(cmd.args, cmd.name + ' argument should be an object');
    this.updateCommandVariables(cmd);
    this.addConfigEnvArray(cmd, 'Env');
    callback();
};

Builder.prototype.cmdExpose = function cmdExpose(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    this.updateCommandVariables(cmd);
    this.addConfigArrayAsMap(cmd, 'ExposedPorts');
    callback();
};

Builder.prototype.cmdFrom = function cmdFrom(cmd, callback) {
    assert.string(cmd.args, 'FROM argument should be a string');
    if (cmd.args === 'scratch') {
        // Nothing to do.
        this.setImageId(null);
        this.setParentId(null);
        callback();
        return;
    }
    this.handleFromImage(cmd, callback);
};

Builder.prototype.cmdLabel = function cmdLabel(cmd, callback) {
    assert.object(cmd.args, cmd.name + ' argument should be an object');
    this.addConfigMap(cmd, 'Label');
    callback();
};

Builder.prototype.cmdMaintainer = function cmdMaintainer(cmd, callback) {
    assert.string(cmd.args, cmd.name + ' argument should be a string');
    this.image.author = cmd.args;
    callback();
};

Builder.prototype.cmdRun = function cmdRun(cmd, callback) {
    // cmd.args can be either a string or an array.
    if (typeof (cmd.args) === 'string') {
        cmd.args = ['/bin/sh', '-c', cmd.args];
    } else {
        assert.arrayOfString(cmd.args, cmd.name
            + ' argument should be an array or a string');
    }
    this.runContainerCommand(cmd, callback);
};

Builder.prototype.cmdUser = function cmdUser(cmd, callback) {
    assert.string(cmd.args, cmd.name + ' argument should be a string');
    this.updateCommandVariables(cmd);
    this.config.User = cmd.args;
    callback();
};

Builder.prototype.cmdVolume = function cmdVolume(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    this.updateCommandVariables(cmd);
    if (!this.config.hasOwnProperty('Volumes')) {
        this.config.Volumes = [];
    }
    this.config.Volumes = this.config.Volumes.concat(cmd.args);
    callback();
};

Builder.prototype.cmdWorkdir = function cmdWorkdir(cmd, callback) {
    assert.string(cmd.args, cmd.name + ' argument should be a string');
    this.updateCommandVariables(cmd);
    // Workdir can be absolute, or relative to existing workdir.
    if (cmd.args[0] === '/') {
        this.config.WorkingDir = cmd.args;
    } else {
        this.config.WorkingDir = path.join(this.config.WorkingDir, cmd.args);
    }
    // Trim trailing slash.
    while (this.config.WorkingDir.slice(-1) === '/') {
        this.config.WorkingDir = this.config.WorkingDir.slice(0, -1);
    }
    callback();
};

Builder.prototype.cmdNotImplemented =
function cmdNotImplemented(cmd, callback)
{
    callback(new Error('Not implemented: ' + cmd.name));
};

Builder.commandMap = {
    'ADD':        Builder.prototype.cmdAdd,
    'CMD':        Builder.prototype.cmdCmd,
    'COPY':       Builder.prototype.cmdCopy,
    'ENTRYPOINT': Builder.prototype.cmdEntrypoint,
    'ENV':        Builder.prototype.cmdEnv,
    'EXPOSE':     Builder.prototype.cmdExpose,
    'FROM':       Builder.prototype.cmdFrom,
    'LABEL':      Builder.prototype.cmdLabel,
    'MAINTAINER': Builder.prototype.cmdMaintainer,
    'ONBUILD':    Builder.prototype.cmdNotImplemented,
    'RUN':        Builder.prototype.cmdRun,
    'USER':       Builder.prototype.cmdUser,
    'VOLUME':     Builder.prototype.cmdVolume,
    'WORKDIR':    Builder.prototype.cmdWorkdir
};


Builder.prototype.step = function step(cmd, callback) {
    var builder = this;

    builder.sendCommandDetails(cmd);

    builder.doStep(cmd, function _doStepCb(err) {
        if (!err) {
            builder.sendLayerId();
        }
        callback(err);
    });
};


Builder.prototype.doStep = function doStep(cmd, callback) {
    var builder = this;
    var cmdHandlerFn = Builder.commandMap[cmd.name];

    if (typeof (cmdHandlerFn) === 'undefined') {
        callback(new Error('Unhandled command: ' + cmd));
        return;
    }

    builder.stepNo += 1;
    builder.setParentId(builder.image.id);
    if (builder.stepNo === (builder.totalNumSteps - 1)) {
        // The last step - use the predetermined final image id.
        builder.setImageId(builder.finalId);
    } else {
        builder.setImageId();
    }

    builder.log.debug('Handling command:', cmd);
    cmdHandlerFn.call(builder, cmd, function cmdHandlerCb(err) {
        if (err) {
            callback(err);
            return;
        }

        builder.image.created = (new Date()).toISOString();
        builder.storeImageLayer(cmd);

        if (builder.onStepFn) {
            builder.log.debug('Running builder onStepFn');
            builder.onStepFn(cmd, callback);
            return;
        }

        callback();
    });
};


Builder.prototype.sendCommandDetails = function sendCommandDetails(cmd) {
    var builder = this;
    var argString = cmd.args;
    if (Array.isArray(argString)) {
        argString = argString.join(' ');
    } else if (typeof (argString) === 'object') {
        // Env or Label -> convert to array of key=value
        argString = Object.keys(argString).map(function (key) {
            return util.format('%s=%s', key, argString[key]);
        });
        argString = argString.join(' ');
    }
    builder.emitStdout(util.format('Step %d : %s %s\n',
                                (builder.stepNo + 1), cmd.name, argString));
};

Builder.prototype.sendLayerId = function sendLayerId() {
    var builder = this;
    if (builder.image.id === null) {
        builder.emitStdout(' --->\n');
    } else {
        builder.emitStdout(util.format(' ---> %s\n', builder.getShortId()));
    }
};


/**
 * copyInfo holds information for file copying from the context into the zone.
 */
function copyInfo(builder, origPath, destPath, allowDecompression) {
    this.builder = builder;
    this.origPath     = origPath;  // Path given in Dockerfile.
    this.destPath     = destPath;  // Dest given in Dockerfile.
    this.hash         = '';    // File (or dir) sha256 checksum.
    this.decompress   = allowDecompression; // If file decompress is allowed.
    this.tmpDir       = '';    // Some files will extract info to a tmpDir.
    this.children     = [];    // Child ci entries (for directories);
}

// Abs path to actual context file.
lazyProperty(copyInfo.prototype, 'contextPath',
function copyInfo_contextPath() {
    var src = path.join(this.builder.contextExtractDir, this.origPath);

    // Sanity check that path is still inside the context extract dir.
    src = fs.realpathSync(src, this.builder.realpathCache);
    var extDirWithSlash = this.builder.contextExtractDir + '/';

    var pathOk = (src.substr(0, extDirWithSlash.length) === extDirWithSlash)
        || (src === this.builder.contextExtractDir);
    if (!pathOk) {
        throw new ForbiddenPathException(
            // Note that there is a deliberate space at the end of this string,
            // to matched the docker/docker build test cases.
            util.format('Forbidden path outside the build context: %s ',
                        this.origPath));
    }

    return src;
});

// Return true if the contextPath is a directory.
lazyProperty(copyInfo.prototype, 'contextPathIsDirectory',
function copyInfo_contextPathIsDirectory() {
    return fs.statSync(this.contextPath).isDirectory();
});

// Abs path to the destination file/directory.
lazyProperty(copyInfo.prototype, 'zoneDestPath',
function copyInfo_zoneDestPath() {
    // If dest ends with a slash, then it's a directory, else it's a file.
    var dest = path.join(this.builder.containerRootDir, this.destPath);
    if (this.destPath.slice(-1) === '/' && !this.contextPathIsDirectory) {
        // If the context is a file, join it to the current dest.
        dest = path.join(dest, this.origPath);
    }

    // Sanity check that path is still inside the zone root.
    var rootDirWithSlash = this.builder.containerRootDir + '/';
    assert.ok((dest.substr(0, rootDirWithSlash.length) === rootDirWithSlash)
            || (dest === this.builder.containerRootDir));

    return dest;
});

// Return true if the contextPath is a directory.
lazyProperty(copyInfo.prototype, 'checksum',
function copyInfo_checksum() {
    assert.ok(!this.contextPathIsDirectory, '!contextPathIsDirectory');
    return utils.fileGetSha256Sync(this.contextPath);
});

copyInfo.prototype.getAllChildren = function copyInfo_getAllChildren() {
    var all = [];
    this.children.forEach(function (cci) {
        all.push(cci);
        if (cci.contextPathIsDirectory) {
            all = all.concat(cci.getAllChildren());
        }
    });
    return all;
};

copyInfo.prototype.getAllChildFiles = function copyInfo_getAllChildFiles() {
    var all = [];
    this.children.forEach(function (cci) {
        if (cci.contextPathIsDirectory) {
            all = all.concat(cci.getAllChildFiles());
        } else {
            all.push(cci);
        }
    });
    return all;
};


Builder.prototype.getCopyInfoFromOpts =
function getCopyInfoFromOpts(opts)
{
    return new copyInfo(this, opts.origPath, opts.destPath,
                        opts.allowDecompression);
};

Builder.prototype.addContextToContainer =
function addContextToContainer(cmd, opts, callback)
{
    assert.object(cmd, 'cmd');
    assert.arrayOfString(cmd.args, 'cmd.args');
    assert.string(cmd.name, 'cmd.name');
    assert.object(opts, 'opts');
    assert.bool(opts.allowRemote, 'opts.allowRemote');
    assert.bool(opts.allowDecompression, 'opts.allowDecompression');

    if (cmd.args.length < 2) {
        callback(new Error(util.format('Invalid %s format - at least two '
                                    + 'arguments required', cmd.name)));
        return;
    }

    var builder = this;
    var copyInfos = [];
    var dest = cmd.args[cmd.args.length - 1]; // last one is always the dest
    // Twiddle the destPath when its a relative path - meaning, make it
    // relative to the WORKINGDIR.
    if (dest.charAt(0) !== '/') {
        assert.ok(this.config.WorkingDir.slice(-1) !== '/',
            'WorkingDir has trailing slash');
        dest = this.config.WorkingDir + '/' + dest;
    }


    async.waterfall([
        function calcCopyInfo(next) {
            // Loop through each src file and calculate the info we need to
            // do the copy (e.g. hash value if cached).  Don't actually do
            // the copy until we've looked at all src files.
            var calcOpts = {
                origPath: '', // Updated in mapFn
                destPath: dest,
                allowRemote: opts.allowRemote,
                allowDecompression: opts.allowDecompression,
                allowWildcards: true
            };
            var mapFn = function addContext_mapFn(fpath, cb) {
                calcOpts.origPath = fpath;
                builder.calculateCopyInfo(cmd, calcOpts, cb);
            };
            var filepaths = cmd.args.slice(0, -1);

            async.mapSeries(filepaths, mapFn,
            function flattenCi(err, cInfoArrays) {
                if (err) {
                    next(err);
                    return;
                }
                // Flatten arrays into just one array.
                copyInfos = cInfoArrays.reduce(function (a, b) {
                    return a.concat(b);
                });

                if (copyInfos.length === 0) {
                    next(new Error('No source files were specified'));
                    return;
                }

                if (copyInfos.length > 1 && dest[dest.length - 1] != '/') {
                    next(new Error(util.format(
                        'When using %s with more than one source '
                        + 'file, the destination must be a '
                        + 'directory and end with a /', cmd.name)));
                    return;
                }
                next();
            });

        }, function checkCache(next) {
            // For backwards compat, if there's just one CI then use it as the
            // cache look-up string, otherwise hash 'em all into one.
            var srcHash = '';
            var origPaths = '';

            if (copyInfos.length == 1) {
                srcHash = copyInfos[0].hash;
                origPaths = copyInfos[0].origPath;
            } else {
                var hashs = [];
                var origs = [];
                copyInfos.every(function (ci) {
                    hashs.push(ci.hash);
                    origs.push(ci.origPath);
                });
                var hasher = crypto.createHash('sha256');
                hasher.update(hashs.join(','));
                srcHash = 'multi:' + hasher.digest('hex');
                origPaths = origs.join(' ');
            }

            var nopHashCmd = util.format('/bin/sh -c #(nop) %s %s in %s',
                cmd.name, srcHash, dest);
            var actualCmd = util.format('%s %s in %s',
                cmd.name, origPaths, dest);
            var hit = builder.checkForCacheHit(nopHashCmd, actualCmd);
            if (hit) {
                // Already have this item in the cache - that's it for the copy.
                callback();
                return;
            }

            next();  // Not cached yet.

        }, function copyFiles(next) {
            // Do the copy/add.
            var copyFn = builder.doCopy.bind(builder);
            async.eachSeries(copyInfos, copyFn, next);
        }
    ], callback);
};

Builder.prototype.calculateCopyInfo =
function calculateCopyInfo(cmd, opts, callback)
{
    assert.object(cmd, 'cmd');
    assert.arrayOfString(cmd.args, 'cmd.args');
    assert.string(cmd.name, 'cmd.name');
    assert.object(opts, 'opts');
    assert.string(opts.origPath, 'opts.origPath');
    assert.string(opts.destPath, 'opts.destPath');
    assert.bool(opts.allowRemote, 'opts.allowRemote');
    assert.bool(opts.allowDecompression, 'opts.allowDecompression');
    assert.bool(opts.allowWildcards, 'opts.allowWildcards');

    if (opts.origPath && opts.origPath.charAt(0) === '/'
        && opts.origPath.length > 1) {

        opts.origPath = opts.origPath.substr(1);
    }

    if (opts.origPath.substr(0, 2) === './') {
        opts.origPath = opts.origPath.substr(2);
    }

    var u = null;

    // In the remote/URL case, download it and gen its hashcode
    try {
        u = url.parse(opts.origPath);
    } catch (e) {
        // Not a url then - that's okay.
    }

    if (u && u.protocol) {
        if (!opts.allowRemote) {
            callback(new Error('Source can\'t be a URL for ' + cmd.name));
            return;
        }

        this.infoForRemoteCopy(cmd, u, opts, callback);
        return;
    }

    // Deal with wildcards
    if (opts.allowWildcards && utils.containsWildcards(opts.origPath)) {
        this.infoForWildcardCopy(cmd, opts, callback);
        return;
    }

    // Must be a dir or a file in the context.
    var ci = this.getCopyInfoFromOpts(opts);

    try {
        // Deal with the single file case
        if (!ci.contextPathIsDirectory) {
            this.infoForFileCopy(ci, callback);
            return;
        }
        // Must be a directory.
        this.infoForDirectoryCopy(ci, opts, callback);
    } catch (ex) {
        if (ex instanceof (ForbiddenPathException)) {
            callback(ex);
            return;
        }
        throw ex;
    }
};

Builder.prototype.infoForFileCopy = function infoForFileCopy(ci, callback)
{
    this.log.debug('infoForFileCopy:', ci.contextPath);
    utils.fileGetSha256(ci.contextPath, function (err, hash) {
        if (err) {
            callback(err);
            return;
        }
        ci.hash = 'file:' + hash;
        callback(null, [ci]);
    });
};

Builder.prototype.infoForDirectoryCopy =
function infoForDirectoryCopy(cmd, opts, callback)
{
    var ci = this.getCopyInfoFromOpts(opts);
    ci.hash = opts.origPath; // Fallback case where there are no child entries.

    this.loadChildInfo(ci, function (err) {
        if (err) {
            callback(err);
            return;
        }

        var cciHashes = ci.getAllChildFiles().map(function childHash_map(cci) {
            return cci.checksum;
        });
        cciHashes.sort();
        var hasher = crypto.createHash('sha256');
        hasher.update(cciHashes.join(','));
        ci.hash = 'dir:' + hasher.digest('hex');

        callback(null, [ci]);
    });
};

Builder.prototype.loadChildInfo = function loadChildInfo(ci, callback) {
    var builder = this;
    fs.readdir(ci.contextPath, function infoLoad_readdir(err, files) {
        if (err) {
            callback(err);
            return;
        }
        ci.children = files.map(function infoLoad_map(name) {
            return builder.getCopyInfoFromOpts({
                origPath: path.join(ci.origPath, name),
                destPath: path.join(ci.destPath, name),
                allowDecompression: ci.allowDecompression
            });
        });
        var ciDirs = ci.children.filter(function infoLoad_filter(cci) {
            return cci.contextPathIsDirectory;
        });
        async.each(ciDirs, builder.loadChildInfo.bind(builder), callback);
    });
};

Builder.prototype.infoForWildcardCopy =
function infoForWildcardCopy(cmd, opts, callback)
{
    if (1 || 1) {
        callback(new Error('Not implemented: need to gather context files'));
        return;
    }

    var i;
    var contextFiles = [];
    var copyInfos = [];
    var fileInfo;
    var matchRe = minimatch.makeRe(opts.origPath);

    for (i = 0; i < contextFiles.length; i++) {
        fileInfo = contextFiles[i];
        if (!fileInfo.name) {
            continue;
        }
        if (!matchRe.match(fileInfo.name)) {
            continue;
        }

        // Note we set allowWildcards to false in case the name has
        // a * in it
        this.calculateCopyInfo(cmd,
        {
            origPath: fileInfo.Name(),
            destPath: opts.destPath,
            allowRemote: opts.allowRemote,
            allowDecompression: opts.allowDecompression,
            allowWildcards: false
        }, function (err, results) {
            if (err) {
                callback(err);
                return;
            }
            copyInfos = copyInfos.concat(results);
        });
    }
    callback(null, copyInfos);
};

Builder.prototype.infoForRemoteCopy =
function infoForRemoteCopy(cmd, u, opts, callback)
{
    callback(new Error(util.format('Not implemented: Add Remote: %j', cmd)));
    return;

// ci = new copyInfo();
// ci.origPath = opts.origPath;
// ci.hash = opts.origPath; // default to this but can change
// ci.destPath = opts.destPath;
// ci.decompress = false;
// copyInfos.push(ci);
//
// // Initiate the download
// resp, err := httputils.Download(ci.origPath)
// if err != nil {
//     return err
// }
//
// // Create a tmp dir
// tmpDirName, err := ioutil.TempDir(b.contextPath, 'docker-remote')
// if err != nil {
//     return err
// }
// ci.tmpDir = tmpDirName
//
// // Create a tmp file within our tmp dir
// tmpFileName := path.Join(tmpDirName, 'tmp')
// tmpFile, err := os.OpenFile(tmpFileName, os.O_RDWR|os.O_CREATE|os.O_EXCL)
// if err != nil {
//     return err
// }
//
// // Download and dump result to tmp file
// if _, err := io.Copy(tmpFile, progressreader.New(progressreader.Config{
//     In:        resp.Body,
//     Out:       b.OutOld,
//     Formatter: b.StreamFormatter,
//     Size:      int(resp.ContentLength),
//     NewLines:  true,
//     ID:        '',
//     Action:    'Downloading',
// })); err != nil {
//     tmpFile.Close()
//     return err
// }
// fmt.Fprintf(b.OutStream, '\n')
// tmpFile.Close()
//
// // Set the mtime to the Last-Modified header value if present
// // Otherwise just remove atime and mtime
// times := make([]syscall.Timespec, 2)
//
// lastMod := resp.Header.Get('Last-Modified')
// if lastMod != '' {
//     mTime, err := http.ParseTime(lastMod)
//     // If we can't parse it then just let it default to 'zero'
//     // otherwise use the parsed time value
//     if err == nil {
//         times[1] = syscall.NsecToTimespec(mTime.UnixNano())
//     }
// }
//
// if err := system.UtimesNano(tmpFileName, times); err != nil {
//     return err
// }
//
// ci.origPath = path.Join(filepath.Base(tmpDirName),
//                         filepath.Base(tmpFileName))
//
// // If the destination is a directory, figure out the filename.
// if strings.HasSuffix(ci.destPath, '/') {
//     u, err := url.Parse(opts.origPath)
//     if err != nil {
//         return err
//     }
//     path := u.Path
//     if strings.HasSuffix(path, '/') {
//         path = path[:len(path)-1]
//     }
//     parts := strings.Split(path, '/')
//     filename := parts[len(parts)-1]
//     if filename == '' {
//         return fmt.Errorf('cannot determine filename from url: %s', u)
//     }
//     ci.destPath = ci.destPath + filename
// }
//
// // Calc the checksum, even if we're using the cache
// r, err := archive.Tar(tmpFileName, archive.Uncompressed)
// if err != nil {
//     return err
// }
// tarSum, err := tarsum.NewTarSum(r, true, tarsum.Version0)
// if err != nil {
//     return err
// }
// if _, err := io.Copy(ioutil.Discard, tarSum); err != nil {
//     return err
// }
// ci.hash = tarSum.Sum(nil)
// r.Close()
//
// return nil
};


//func (b *Builder) pullImage(name string) (*imagepkg.Image, error) {
//    remote, tag := parsers.ParseRepositoryTag(name)
//    if tag == '' {
//        tag = 'latest'
//    }
//
//    pullRegistryAuth := &cliconfig.AuthConfig{}
//    if len(b.AuthConfigs) > 0 {
//        // Request came with a full auth config file, we prefer to use that
//        repoInfo, err := b.Daemon.RegistryService.ResolveRepository(remote)
//        if err != nil {
//            return nil, err
//        }
//
//        resolvedConfig := registry.ResolveAuthConfig(
//            &cliconfig.ConfigFile{AuthConfigs: b.AuthConfigs},
//            repoInfo.Index,
//        )
//        pullRegistryAuth = &resolvedConfig
//    }
//
//    imagePullConfig := &graph.ImagePullConfig{
//        AuthConfig: pullRegistryAuth,
//        OutStream:  ioutils.NopWriteCloser(b.OutOld),
//    }
//
//    var err = b.Daemon.Repositories().Pull(remote, tag, imagePullConfig);
//    if err != nil {
//        return nil, err
//    }
//
//    image, err := b.Daemon.Repositories().LookupImage(name)
//    if err != nil {
//        return nil, err
//    }
//
//    return image, nil
//}
//
//func (b *Builder) processImageFrom(img *imagepkg.Image) error {
//    b.image = img.ID
//
//    if img.Config != nil {
//        b.Config = img.Config
//    }
//
//    if len(b.Config.Env) == 0 {
//        b.Config.Env = append(b.Config.Env, 'PATH='+daemon.DefaultPathEnv)
//    }
//
//    // Process ONBUILD triggers if they exist
//    if nTriggers := len(b.Config.OnBuild); nTriggers != 0 {
//        fmt.Fprintf(b.ErrStream, '# Executing %d build triggers\n', nTriggers)
//    }
//
//    // Copy the ONBUILD triggers, and remove them from the config,
//    // since the config will be committed.
//    onBuildTriggers := b.Config.OnBuild
//    b.Config.OnBuild = []string{}
//
//    // parse the ONBUILD triggers by invoking the parser
//    for stepN, step := range onBuildTriggers {
//        ast, err := parser.Parse(strings.NewReader(step))
//        if err != nil {
//            return err
//        }
//
//        for i, n := range ast.Children {
//            switch strings.ToUpper(n.Value) {
//            case 'ONBUILD':
//                return fmt.Errorf('Chaining ONBUILD via `ONBUILD ONBUILD`'
//                                  'isn\'t allowed')
//            case 'MAINTAINER', 'FROM':
//                return fmt.Errorf('%s isn't allowed as an ONBUILD trigger',
//                                  n.Value)
//            }
//
//            fmt.Fprintf(b.OutStream, 'Trigger %d, %s\n', stepN, step)
//
//            if err := b.dispatch(i, n); err != nil {
//                return err
//            }
//        }
//    }
//
//    return nil
//}

Builder.prototype.doCopy = function doCopy(ci, callback)
{
    if (ci.contextPathIsDirectory) {
        return this.doCopyDirectory(ci, callback);
    }
    this.log.debug('copying file %j to %j', ci.contextPath, ci.zoneDestPath);
    // Ensure parent directory exists, then copy file to it.
    var parentDir = path.dirname(ci.zoneDestPath);
    mkdirp(parentDir, function (err) {
        if (err) {
            callback(err);
            return;
        }
        utils.fileCopy(ci.contextPath, ci.zoneDestPath, callback);
    });
};

Builder.prototype.doCopyDirectory = function doCopyDirectory(ci, callback)
{
    var builder = this;
    mkdirp(ci.zoneDestPath, function (err) {
        if (err) {
            callback(err);
            return;
        }
        builder.log.debug('copying directory %j to %j',
            ci.contextPath, ci.zoneDestPath);
        async.eachSeries(ci.getAllChildren(), builder.doCopy.bind(builder),
            callback);
    });
};

Builder.prototype.handleFromImage = function handleFromImage(cmd, callback)
{
    var builder = this;
    var cb = function (err, result) {
        if (!err) {
            // Store the image information.
            // XXX: Make note of expected fields in this callback result.
            var config = result.image.config;
            builder.image.config = config;
            builder.config = config;
            builder.setImageId(result.image.docker_id);
            builder.setParentId(config.Image || null);
        }
        callback(err);
    };
    var event = {
        callback: cb,
        imageName: cmd.args,
        type: 'image_reprovision'
    };
    builder.emitTask(event);
};

Builder.prototype.runContainerCommand =
function runContainerCommand(cmd, callback)
{
    var builder = this;
    var cb = function (err, result) {
        if (!err && result.exitCode !== 0) {
            err = new Error(util.format('The command \'%s\' returned a '
                + 'non-zero code: %d', cmd.args.join(' '), result.exitCode));
        }
        callback(err);
    };
    var event = {
        callback: cb,
        cmd: cmd.args,
        workdir: builder.config.WorkingDir || '/',
        env: builder.config.Env || [],
        type: 'run',
        user: builder.config.User
    };
    builder.emitTask(event);
};


module.exports = {
    Builder: Builder
};
