/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
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
var dockerFileParser = require('docker-file-parser');
var jsprim = require('jsprim');
var lazyProperty = require('lazy-property');
var libuuid = require('libuuid');
var minimatch = require('minimatch');
var once = require('once');

var magic = require('./magic');
var shellparser = require('./shellparser');
var utils = require('./utils');


const MAX_DOCKERFILE_LENGTH = 10 * 1024 * 1024;  // 10 Mb

const DEFAULT_IMAGE_CONFIG = {
    'AttachStdin': false,
    'AttachStderr': false,
    'AttachStdout': false,
    'Cmd': null,
    'Domainname': '',
    'Entrypoint': null,
    'Env': null,
    'Hostname': '',
    'Image': '',
    'Labels': null,
    'OnBuild': null,
    'OpenStdin': false,
    'StdinOnce': false,
    'Tty': false,
    'User': '',
    'Volumes': null,
    'WorkingDir': ''
};

// Array of all possible docker config properties.
const KNOWN_CONFIG_NAMES = [
    'AttachStdin',
    'AttachStderr',
    'AttachStdout',
    'Cmd',
    'Domainname',
    'Entrypoint',
    'Env',
    'ExposedPorts',
    'Hostname',
    'Image',
    'Labels',
    'MacAddress',
    'NetworkDisabled',
    'OnBuild',
    'OpenStdin',
    'PublishService',
    'StdinOnce',
    'StopSignal',
    'Tty',
    'User',
    'Volumes',
    'WorkingDir'
];

const DEFAULT_ARG_NAMES = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'FTP_PROXY',
    'NO_PROXY',
    // Same again, but lowercase... urgh.
    'http_proxy',
    'https_proxy',
    'ftp_proxy',
    'no_proxy'
];


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
 *    - 'extract_tarfile', when needing to extract a tarfile resource
 *    - 'image_reprovision', to reprovision the vm with the given image
 *    - 'run', which means to run the given cmd inside of the vm
 *    - 'commands_finished', notify build has finished all dockerfile commands
 *  'image_reprovisioned' - fn(event) when image reprovision has completed
 */
function Builder(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.commandType, 'opts.commandType');
    assert.string(opts.workDir, 'opts.workDir');
    assert.string(opts.containerRootDir, 'opts.containerRootDir');
    assert.string(opts.contextFilepath, 'opts.contextFilepath');
    assert.optionalString(opts.dockerfile, 'opts.dockerfile');
    assert.optionalBool(opts.suppressSuccessMsg, 'opts.suppressSuccessMsg');
    assert.optionalArrayOfObject(opts.existingImages, 'opts.existingImages');
    assert.optionalString(opts.buildargs, 'opts.buildargs'); // JSON-encod array
    assert.optionalString(opts.labels, 'opts.labels'); // JSON encoded object
    assert.optionalBool(opts.nocache, 'opts.nocache');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.uuid, 'opts.uuid');

    // Command type must be one of 'build' or 'commit'.
    assert.ok(opts.commandType === 'build' || opts.commandType === 'commit',
        'Unknown command type: ' + opts.commandType);

    // Allow emitting of events.
    EventEmitter.call(this);

    this.commandType = opts.commandType;
    this.workDir = opts.workDir;
    this.containerRootDir = opts.containerRootDir;
    this.contextFilepath = opts.contextFilepath;
    this.dockerfile = opts.dockerfile || 'Dockerfile';
    this.suppressSuccessMsg = opts.suppressSuccessMsg || false;
    this.cliBuildArgs = JSON.parse(opts.buildargs || '[]');
    this.cliLabels = JSON.parse(opts.labels || '{}');
    this._existingImages = opts.existingImages || [];
    this.log = opts.log;
    this.zoneUuid = opts.uuid;
    // Caching variables.
    this.cacheEnabled = !opts.nocache;  // Client allows use of the cache.
    this.cacheLastCmdCached = true;  // Was the last cmd found in the cache.

    this.contextDir = path.join(this.workDir, 'dockerbuild');
    this.contextExtractDir = path.join(this.contextDir, 'extracted');
    // Generated image layers during build, each entry is map of:
    //   { cmd: Object, image: Object }
    this.layers = [];
    this.realpathCache = {}; // Used to cache realpath lookups.
    this.stepNo = -1; // Command step number.
    this.totalNumSteps = 0;  // Number of dockerfile commands to be run.
    this.cmdSet = false;     // If a CMD entry has been processed.

    // Used to chown files to root user.
    this.chownUid = 0;
    this.chownGid = 0;

    // ARG entries, used with cliBuildArgs.
    // 'buildArgs' is what has been specified via command line.
    // 'buildArgsPlusDefaults' is 'buildArgs' plus the default args.
    this.buildArgs = {};
    this.buildArgsPlusDefaults = {};
    var builder = this;
    DEFAULT_ARG_NAMES.map(function (arg) {
        builder.addArgEntry(arg, null);
    });

    // Docker image format:
    this.image = {
        'architecture': 'amd64',
        'config': jsprim.deepCopy(DEFAULT_IMAGE_CONFIG),
        'os': 'linux',
        'parent': null
    };
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
    this.log.debug('Setting image id to: %s', id);
    this.image.id = id;
    return id;
};

Builder.prototype.setParentId = function setParentId(id) {
    this.log.debug('Setting parent id to: %s', id);
    this.image.parent = id;
    this.image.config.Image = id;
    if (this.image.hasOwnProperty('container_config')) {
        this.image.container_config.Image = id;
    }
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
 * Array of known docker images (objects are in the docker inspect format).
 */
lazyProperty(Builder.prototype, 'existingImages',
function builder_existingImages()
{
    return this._existingImages.map(function (img) {
        return jsprim.mergeObjects(img, null, DEFAULT_IMAGE_CONFIG);
    });
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
            log.info('dockerfileContents: ', dockerfileContents);
            if (!dockerfileContents) {
                next(new Error(util.format('The Dockerfile (%s) cannot be '
                                + 'empty', builder.dockerfile)));
                return;
            }
            var commands = dockerFileParser.parse(dockerfileContents);
            builder.totalNumSteps = commands.length;
            next(null, commands);
        },
        function removeIgnoredContextFiles(allCommands, next) {
            // TODO:
            // After the Dockerfile has been parsed, we need to check the
            // .dockerignore file for either "Dockerfile" or ".dockerignore",
            // and if either are present then erase them from the build context.
            // These files should never have been sent from the client but we
            // did send them to make sure that we had the Dockerfile to actually
            // parse, and then we also need the .dockerignore file to know
            // whether either file should be removed. Note that this assumes the
            // Dockerfile has been read into memory and is now safe to be
            // removed.
            next(null, allCommands);
        },
        function process(allCommands, next) {
            log.info('processing', allCommands.length, 'commands');
            async.eachSeries(allCommands, function commandBuildStep(cmd, cb) {
                builder.onBuildTriggers = null;
                builder.step(cmd, function stepCb(err) {
                    if (err) {
                        cb(err);
                        return;
                    }
                    builder.runOnBuildTriggers(builder.onBuildTriggers, cb);
                });
            }, next);
        },
        function checkBuildArgs(next) {
            log.debug('checkBuildArgs: %j', builder.cliBuildArgs);
            if (!jsprim.isEmpty(builder.cliBuildArgs)) {
                next(new Error(util.format('One or more build-args [%s] were '
                    + 'not consumed, failing build.',
                    Object.keys(builder.cliBuildArgs))));
                return;
            }
            next();
        },
        function checkImagesCreated(next) {
            // Check if it's empty.
            if ((builder.layers.length === 0)
                // Or it's just the scratch image layer.
                || (builder.layers.length === 1
                    && builder.layers[0].cmd.name === 'FROM'
                    && builder.layers[0].cmd.args === 'scratch')) {
                next(new Error('No image was generated. Is your '
                                + 'Dockerfile empty?'));
                return;
            }
            next();
        }
    ], function (err) {
        if (err) {
            log.debug('emitting failure, err: %j', err);
            log.error(err);
        } else {
            log.debug('emitting success');
            if (!builder.suppressSuccessMsg) {
                builder.emitStdout(util.format('Successfully built %s\n',
                                                builder.getShortId()));
            }
        }
        log.info('Final image layers:\n%s',
            util.inspect(builder.layers, { depth: 5 }));
        builder.emit('end', err);
    });
};

Builder.prototype.startCommit = function startCommit(fromImage, changes) {
    var builder = this;
    var log = builder.log;

    var dockerfileContents = changes.join('\n');

    builder.setFromInspectImage(jsprim.deepCopy(fromImage));
    builder.storeImageLayer(null);

    async.waterfall([
        function parse(next) {
            log.info('dockerfileContents: ', dockerfileContents);
            var commands = dockerFileParser.parse(dockerfileContents);
            builder.totalNumSteps = commands.length;
            next(null, commands);
        },
        function verifyCommands(allCommands, next) {
            // Commit changes can only use a subset of the regular docker build
            // instructions.
            log.info('verifying commit commands');
            var forbiddenCommands = allCommands.filter(function (cmd) {
                return [
                    'ADD', 'ARG', 'COPY', 'FROM', 'MAINTAINER', 'RUN'
                ].indexOf(cmd.name) >= 0;
            });
            if (forbiddenCommands.length > 0) {
                next(new Error(util.format('%s is not a valid change '
                    + 'command', forbiddenCommands[0].name)));
                return;
            }
            next(null, allCommands);
        },
        function process(allCommands, next) {
            log.info('processing', allCommands.length, 'commands');
            // Add a cmd.ctx entry - required for doStep and friends.
            for (var i = 0; i < allCommands.length; i++) {
                allCommands[i].ctx = {};
            }
            // Run the command.
            async.eachSeries(allCommands, builder.doActualStep.bind(builder),
                next);
        },
        // Generate a unique id for the committed image.
        function generateFinalImage(next) {
            builder.setParentId(builder.image.id);
            builder.setImageId();
            builder.image.created = (new Date()).toISOString();
            builder.storeImageLayer(null);
            next();
        }
    ], function (err) {
        if (err) {
            log.debug('startCommit failure, err: %j', err);
            log.error(err);
        } else {
            log.debug('startCommit success');
        }
        log.info('Final image layers:\n%s',
            util.inspect(builder.layers, { depth: 5 }));
        builder.emit('end', err);
    });
};

Builder.prototype.emitError = function emitError(msg) {
    this.log.error(msg);
    this.emitStdout(util.format('ERROR: %s\n', msg));
};

Builder.prototype.emitStdout = function emitStdout(message) {
    if (this.commandType === 'commit') {
        // No stdout messages are sent for 'docker commit'.
        return;
    }
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
    var builder = this;
    var dockerfilePath;
    var i;
    var resolvedDest;
    var stat;

    var dockerfilenames = [builder.dockerfile];
    if (builder.dockerfile === 'Dockerfile') {
        // Allow lowercase version of the dockerfile.
        dockerfilenames.push('dockerfile');
    }

    /* jsl:ignore - not smart enough to infer that 'return' is wanted. */
    for (i = 0; i < dockerfilenames.length; i++) {
    /* jsl:end */
        // Ensure the dockerfile isn't outside of the extract directory.
        try {
            resolvedDest = getRealpathFromRootDir(dockerfilenames[i],
                builder.contextExtractDir);
        } catch (ex) {
            if (ex instanceof ForbiddenPathException) {
                callback(ex);
                return;
            }
            throw ex;
        }

        dockerfilePath = path.join(builder.contextExtractDir, resolvedDest);
        try {
            stat = fs.statSync(dockerfilePath);
        } catch (e) {
            // Try next filename.
            continue;
        }
        if (stat.size > MAX_DOCKERFILE_LENGTH) {
            var errorMsg = 'Dockerfile exceeds max length: ' + stat.size;
            callback(new Error(errorMsg));
            return;
        }
        fs.readFile(dockerfilePath, callback);
        return;
    }

    callback(new Error(util.format('Error: No such file or directory \'%s\'',
        builder.dockerfile)));
};

Builder.prototype.storeImageLayer = function storeImageLayer(cmd) {
    // Docker images use a 256-bit id value, general uuid's are 128-bits.
    var builder = this;

    builder.log.debug('Storing config for buildstep %d', builder.stepNo);

    builder.layers.push({
        cmd: cmd,
        image: jsprim.deepCopy(builder.image)
    });
};

Builder.prototype.isLastStep = function isLastStep() {
    return this.stepNo === (this.totalNumSteps - 1);
};

Builder.prototype.isCachingAllowed = function isCachingAllowed(cmd) {
    return this.cacheEnabled && this.cacheLastCmdCached;
};

function fixShellCommandArguments(cmd) {
    if (typeof (cmd.args) === 'string') {
        cmd.args = ['/bin/sh', '-c', cmd.args];
    } else {
        assert.arrayOfString(cmd.args, cmd.name
            + ' argument should be an array or a string');
    }
}

function getCommandString(cmd) {
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
    return cmd.name + ' ' + argString;
}

Builder.prototype.getNopCmdForCommand = function getNopCmdForCommand(cmd) {
    var builder = this;
    var cmdArray = [];
    var cmdString = getCommandString(cmd);
    var keys;
    var str;

    // NOP commands are percucilar in docker... and we follow their
    // formatting designs below (see builder/dockerfile/dispatchers.go).

    if (cmd.name === 'RUN') {
        // Prepend all *currently* defined ARGS to the command string, but strip
        // out any args that don't have a set value.
        keys = Object.keys(builder.buildArgs).filter(function (arg) {
            return builder.buildArgs[arg] !== null;
        });
        if (keys.length > 0) {
            cmdArray.push(util.format('|%d', keys.length));
            cmdArray = cmdArray.concat(keys.map(function (arg) {
                return util.format('%s=%s', arg, builder.buildArgs[arg]);
            }));
        }
        if (Array.isArray(cmd.args)) {
            return cmdArray.concat(cmd.args);
        }
        return cmdArray.concat(['/bin/sh', '-c', '#(nop) ' + cmdString]);
    }

    if (cmd.name === 'ADD' || cmd.name === 'COPY') {
        var typeHash = generateHashForCopyInfos(cmd.ctx.copyInfos);
        var inDir = cmd.args.slice(-1)[0];
        cmdString = util.format('%s %s in %s', cmd.name, typeHash, inDir);
    } else if (cmd.name === 'ENTRYPOINT' || cmd.name === 'CMD') {
        str = cmd.args.map(function (arg) {
            return '"' + arg + '"';
        }).join(' ');
        cmdString = '[' + str + ']';
    }

    return ['/bin/sh', '-c', '#(nop) ' + cmdString];
};

Builder.prototype.getCachedImage = function getCachedImage(cmd) {
    var builder = this;
    var log = builder.log;

    var configNopCmd = builder.getNopCmdForCommand(cmd);
    var parentId = builder.image.parent;
    log.debug('getCachedImage: looking for image with parent %s, nop cmd %j',
        parentId, configNopCmd);

    var cfgs = builder.existingImages.filter(function existCfgFilter(img) {
        // Images must have the same parent and Cmd entry.
        if ((img.ContainerConfig.Image !== parentId)
            || !(jsprim.deepEqual(configNopCmd, img.ContainerConfig.Cmd)))
        {
            return false;
        }

        // Some fields (like Labels) can also be set from the client, check that
        // these fields remain the same.
        if (!(jsprim.deepEqual(builder.image.config.Labels, img.Config.Labels)))
        {
            return false;
        }

        return true;
    });

    return cfgs[0];
};

function getMergedEnvArgArray(envArray, argMap) {
    var env = jsprim.deepCopy(envArray);
    // Ensure there is always a default PATH env.
    if (!env.some(function (entry) {
        return entry.substr(0, 5) === 'PATH=';
    })) {
        env.push('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:'
            + '/sbin:/bin');
    }

    // Add build ARG entries - but existing env have priority over ARG entries.
    Object.keys(argMap).forEach(function (key) {
        var val;
        var exists = env.some(function (entry) {
            if (entry.length <= key.length) {
                return key === entry;
            }
            return entry.substr(0, key.length + 1) === (key + '=');
        });
        if (!exists) {
            val = argMap[key];
            if (val !== null) {
                env.push(util.format('%s=%s', key, val));
            } else {
                env.push(key);
            }
        }
    });

    return env;
}

Builder.prototype.updateCommandVariables =
function updateCommandVariables(cmd)
{
    // If there's no $, quotes or backslash then no need to process the command.
    /* JSSTYLED */ // this is regex, not a string!
    if (cmd.raw.search(/[\\$'\"]/) === -1) {
        return;
    }

    var builder = this;
    var env = builder.image.config.Env || [];
    var origArgs = jsprim.deepCopy(cmd.args);

    env = getMergedEnvArgArray(env, builder.buildArgsPlusDefaults);

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

    builder.log.debug('variables: updated cmd %s from %j to %j',
        cmd.name, origArgs, cmd.args);
};

Builder.prototype.addConfigMap = function addConfigMap(args, propName) {
    var config = this.image.config;
    if (!config.hasOwnProperty(propName) || config[propName] === null) {
        config[propName] = {};
    }
    var map = config[propName];

    Object.keys(args).forEach(function (key) {
        map[key] = args[key];
    });
};

Builder.prototype.addConfigArrayAsMap =
function addConfigArrayAsMap(args, propName)
{
    var config = this.image.config;
    if (!config.hasOwnProperty(propName) || config[propName] === null) {
        config[propName] = {};
    }
    var map = config[propName];

    args.forEach(function (val) {
        map[val] = {};
    });
};

Builder.prototype.addConfigEnvArray =
function addConfigEnvArray(args, propName)
{
    var config = this.image.config;
    if (!config.hasOwnProperty(propName) || config[propName] === null) {
        config[propName] = [];
    }
    var arr = config[propName];

    // Replace existing key if it exists.
    Object.keys(args).forEach(function (key) {
        var existingIdx = -1;
        var findExistingFn = function (entry) {
            existingIdx += 1;
            return entry[key.length] === '='
                && entry.substr(0, key.length) === key;
        };
        if (arr.some(findExistingFn)) {
            // There is a an existing match.
            arr[existingIdx] = key + '=' + args[key];
        } else {
            arr.push(key + '=' + args[key]);
        }
    });
};


// Note: This function is also called for COPY command.
Builder.prototype.cmdAddPreFn = function cmdAddPreFn(cmd, callback) {
    var builder = this;
    // Calculate hashes of the context files, to check if they have changed.
    builder.getCopyInfo(cmd, {
        allowRemote: (cmd.name === 'ADD'),
        allowDecompression: (cmd.name === 'ADD')
    }, function _getCopyInfoCb(err, copyInfos) {
        cmd.ctx.copyInfos = copyInfos;
        callback(err);
    });
};
Builder.prototype.cmdAdd = function cmdAdd(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    assert.object(cmd.ctx, 'cmd.ctx');
    // Note: copyInfos are populated in the cmdAddPreFn.
    assert.arrayOfObject(cmd.ctx.copyInfos, 'cmd.ctx.copyInfos');

    this.performCopy(cmd, cmd.ctx.copyInfos, callback);
};

Builder.prototype.addArgEntry = function addArgEntry(name, value) {
    var builder = this;
    // ARG entries are allowed to overwritten by the client - check if this one
    // was overwritten.
    if (builder.cliBuildArgs.hasOwnProperty(name)) {
        value = builder.cliBuildArgs[name];
        builder.log.debug('Updating buildarg %j to cli value %j', name, value);
        // Delete cli name - as we check that all of these get consumed.
        delete builder.cliBuildArgs[name];
        // Remember this arg, as it will be included in the run command env.
        builder.buildArgs[name] = value;
    } else if (value !== null) {
        builder.buildArgs[name] = value;
    }

    builder.buildArgsPlusDefaults[name] = value;
};

Builder.prototype.cmdArg = function cmdArg(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    var builder = this;

    if (cmd.args.length !== 1) {
        callback(new Error('ARG requires exactly one argument definition'));
        return;
    }

    cmd.args.forEach(function (name) {
        var idx = name.indexOf('=');
        var val = null;
        if (idx >= 0) {
            val = name.slice(idx+1);
            name = name.slice(0, idx);
        }

        builder.addArgEntry(name, val);
    });

    callback();
};

Builder.prototype.cmdCmdPreFn = function cmdCmdPreFn(cmd, callback) {
    fixShellCommandArguments(cmd);
    callback();
};
Builder.prototype.cmdCmd = function cmdCmd(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    this.image.config.Cmd = cmd.args.slice();  // a copy
    this.cmdSet = true;
    callback();
};

Builder.prototype.cmdEntrypointPreFn =
function cmdEntrypointPreFn(cmd, callback)
{
    fixShellCommandArguments(cmd);
    callback();
};
Builder.prototype.cmdEntrypoint = function cmdEntrypoint(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    this.image.config.Entrypoint = cmd.args.slice();  // a copy
    // Clear Cmd when Entrypoint is set but Cmd wasn't set in *this* build.
    if (!this.cmdSet) {
        this.image.config.Cmd = null;
    }
    callback();
};

Builder.prototype.cmdEnv = function cmdEnv(cmd, callback) {
    assert.object(cmd.args, cmd.name + ' argument should be an object');
    this.addConfigEnvArray(cmd.args, 'Env');
    callback();
};

Builder.prototype.cmdExposePreFn = function cmdExposePreFn(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    // Lowercase the args.
    cmd.args = cmd.args.map(function (s) { return s.toLowerCase(); });
    callback();
};
Builder.prototype.cmdExpose = function cmdExpose(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    var err = null;
    // Parse the entries.
    var ports = cmd.args.map(function expandPortArgsMap(port) {
        // Ports default to TCP if no protocol is supplied.
        var i;
        var proto = 'tcp';
        var sp = port.split('/');
        if (sp.length >= 2) {
            port = sp[0];
            proto = sp[1];
        }
        // Handle port ranges, e.g. 8000-8010
        sp = port.split('-');
        if (sp.length >= 2) {
            var begin = parseInt(sp[0], 10);
            var end = parseInt(sp[1], 10);
            if (end < begin) {
                err = new Error(util.format('Invalid containerPort: %s', port));
                return;
            }
            var portArray = [];
            for (i = begin; i <= end; i++) {
                portArray.push(util.format('%s/%s', i, proto));
            }
            return portArray;
        }
        return util.format('%s/%s', port, proto);
    });
    if (err) {
        callback(err);
        return;
    }
    // Flatten all port array entries.
    ports = [].concat.apply([], ports);
    this.addConfigArrayAsMap(ports, 'ExposedPorts');
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
    this.addConfigMap(cmd.args, 'Labels');
    callback();
};

Builder.prototype.cmdMaintainer = function cmdMaintainer(cmd, callback) {
    assert.string(cmd.args, cmd.name + ' argument should be a string');
    this.image.author = cmd.args;
    callback();
};

Builder.prototype.cmdOnBuild = function cmdOnBuild(cmd, callback) {
    assert.object(cmd.args, cmd.name + ' argument should be an object');
    if (!this.image.config.OnBuild) {
        this.image.config.OnBuild = [];
    }
    // The cmd.args should be a cmd object for onbuild instructions.
    assert.object(cmd.args);
    this.image.config.OnBuild.push(cmd.args.raw);
    callback();
};

Builder.prototype.cmdRunPreFn = function cmdRunPreFn(cmd, callback) {
    fixShellCommandArguments(cmd);
    callback();
};
Builder.prototype.cmdRun = function cmdRun(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    this.runContainerCommand(cmd, callback);
};

Builder.prototype.cmdStopSignal = function cmdStopSignal(cmd, callback) {
    assert.string(cmd.args, cmd.name + ' argument should be a string');
    this.image.config.StopSignal = cmd.args;
    callback();
};

Builder.prototype.cmdUser = function cmdUser(cmd, callback) {
    assert.string(cmd.args, cmd.name + ' argument should be a string');
    this.image.config.User = cmd.args;
    callback();
};

Builder.prototype.cmdVolume = function cmdVolume(cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    if (!cmd.args[0]) {
        callback(new Error('Volume specified can not be an empty string'));
        return;
    }
    this.addConfigArrayAsMap(cmd.args, 'Volumes');
    callback();
};

Builder.prototype.cmdWorkdir = function cmdWorkdir(cmd, callback) {
    assert.string(cmd.args, cmd.name + ' argument should be a string');
    // Workdir can be absolute, or relative to existing workdir.
    var config = this.image.config;
    if (cmd.args[0] === '/') {
        config.WorkingDir = cmd.args;
    } else {
        config.WorkingDir = path.join(config.WorkingDir, cmd.args);
    }
    // Ensure the working directory is normalized and remove any trailing slash
    // to be consistent with docker.
    config.WorkingDir = path.normalize(config.WorkingDir);
    if (config.WorkingDir.length > 1
        && config.WorkingDir[config.WorkingDir.length-1] === '/') {
        config.WorkingDir = config.WorkingDir.slice(0, -1);  // remove last char
    }
    callback();
};

Builder.prototype.cmdNotImplemented =
function cmdNotImplemented(cmd, callback)
{
    callback(new Error('Not implemented: ' + cmd.name));
};

// Dispatch table of a command name to it's functions. Each one is a map which
// can hold a `fn` and an optional `preFn`. The `preFn` is called prior to
// running the actual command (to tweak the command arguments and be ready for
// cmd caching checks). `fn` is called to do the meat of the work, but will not
// be called if the command is already cached.
Builder.commandMap = {
    'ADD':        { fn: Builder.prototype.cmdAdd,
                    preFn: Builder.prototype.cmdAddPreFn },
    'ARG':        { fn: Builder.prototype.cmdArg },
    'CMD':        { fn: Builder.prototype.cmdCmd,
                    preFn: Builder.prototype.cmdCmdPreFn },
    'COPY':       { fn: Builder.prototype.cmdAdd,            // same as ADD
                    preFn: Builder.prototype.cmdAddPreFn },  // same as ADD
    'ENTRYPOINT': { fn: Builder.prototype.cmdEntrypoint,
                    preFn: Builder.prototype.cmdEntrypointPreFn },
    'ENV':        { fn: Builder.prototype.cmdEnv },
    'EXPOSE':     { fn: Builder.prototype.cmdExpose,
                    preFn: Builder.prototype.cmdExposePreFn },
    'FROM':       { fn: Builder.prototype.cmdFrom },
    'LABEL':      { fn: Builder.prototype.cmdLabel },
    'MAINTAINER': { fn: Builder.prototype.cmdMaintainer },
    'ONBUILD':    { fn: Builder.prototype.cmdOnBuild },
    'RUN':        { fn: Builder.prototype.cmdRun,
                    preFn: Builder.prototype.cmdRunPreFn },
    'STOPSIGNAL': { fn: Builder.prototype.cmdStopSignal },
    'USER':       { fn: Builder.prototype.cmdUser },
    'VOLUME':     { fn: Builder.prototype.cmdVolume },
    'WORKDIR':    { fn: Builder.prototype.cmdWorkdir }
};


Builder.prototype.step = function step(cmd, callback) {
    var builder = this;

    builder.stepNo += 1;
    builder.log.debug('Starting build step %d', builder.stepNo);

    builder.setParentId(builder.image.id);
    builder.setImageId();

    builder.doStep(cmd, function _doStepCb(err) {
        if (err) {
            callback(err);
            return;
        }
        builder.sendLayerId();
        callback();
    });
};


Builder.prototype.doStep = function doStep(cmd, callback) {
    var builder = this;

    // Add a context variable onto the cmd.
    cmd.ctx = {};

    builder.sendCommandDetails(cmd);

    // The first command has to be the `FROM` command.
    if (builder.stepNo === 0 && cmd.name !== 'FROM') {
        callback(new Error('Please provide a source image with '
            + '`from` prior to commit'));
        return;
    }

    async.waterfall([
        function preStep(next) {
            builder.doPreStep(cmd, next);
        },
        function checkCache(next) {
            builder.doCheckCache(cmd, next);
        },
        function actualStep(next) {
            builder.doActualStep(cmd, next);
        },
        function postStep(next) {
            builder.doPostStep(cmd, next);
        }
    ], callback);
};


// Check if a command allows variable replacement of it's arguments.
Builder.prototype.cmdAllowsVariables =
function cmdAllowsVariables(cmd, callback)
{
    return [
        'ADD', 'ARG', 'COPY', 'ENV', 'EXPOSE', 'LABEL', 'ONBUILD',
        'STOPSIGNAL', 'USER', 'VOLUME', 'WORKDIR'
    ].indexOf(cmd.name) >= 0;
};


// Allow customization before the step is performed.
Builder.prototype.doPreStep = function doPreStep(cmd, callback) {
    var builder = this;
    var cmdHandler = Builder.commandMap[cmd.name];

    if (builder.isLastStep() && !jsprim.isEmpty(builder.cliLabels)) {
        // Add client labels - but we only want to add labels to the last layer.
        builder.log.debug('adding builder cliLabels: %j', builder.cliLabels);
        builder.addConfigMap(builder.cliLabels, 'Labels');
    }

    if (builder.cmdAllowsVariables(cmd)) {
        builder.updateCommandVariables(cmd);
    }

    if ((typeof (cmdHandler) === 'undefined')
        || (typeof (cmdHandler.preFn) === 'undefined')) {

        callback();
        return;
    }

    builder.log.info('Calling preFn for', cmd.name);
    cmdHandler.preFn.call(builder, cmd, callback);
};


Builder.prototype.setFromInspectImage =
function setFromInspectImage(inspectImg) {
    var builder = this;
    builder.image.config = inspectImg.Config;
    builder.image.container_config = inspectImg.ContainerConfig;
    builder.setImageId(inspectImg.Id);
    builder.setParentId(inspectImg.Parent);
};


/**
 * Check the image cache to see if the build cmd is already created.
 *
 * When the cmd is already cached, cmd.ctx.isCached will be set to true.
 */
Builder.prototype.doCheckCache = function doCheckCache(cmd, callback) {
    var builder = this;
    var log = builder.log;

    if (cmd.name === 'FROM') {
        log.debug('doCheckCache: ignoring caching for FROM command');
        callback();
        return;
    }

    if (!builder.isCachingAllowed()) {
        log.debug('doCheckCache: caching not allowed');
        callback();
        return;
    }

    var lastCmdWasCached = builder.cacheLastCmdCached;
    var cachedImage = builder.getCachedImage(cmd);
    if (!cachedImage) {
        // Not cached.
        log.debug('doCheckCache: no cached image');
        builder.cacheLastCmdCached = false;
        var lastLayer = builder.layers[builder.layers.length-1];
        if (lastLayer && lastCmdWasCached && lastLayer.cmd.name !== 'FROM') {
            // The last command was cached, so reprovision to the last image.
            log.debug('doCheckCache: reprovisioning onto step %d, cmd: %s',
                (builder.stepNo - 1), lastLayer.cmd.raw);
            builder.reprovisionImage(cmd, builder.image.parent, function (err) {
                if (!err) {
                    // Update the config.Image (parent).
                    builder.setParentId(builder.image.parent);
                }
                callback(err);
            });
            return;
        }
        callback();
        return;
    }

    // Cached image - note that cachedImage is in the inspect object format.
    log.info('doCheckCache: found cached image %s', cachedImage.Id);
    cmd.ctx.isCached = true;
    builder.emitStdout(' ---> Using cache\n');
    builder.setFromInspectImage(cachedImage);

    callback();
};


Builder.prototype.doActualStep = function doActualStep(cmd, callback) {
    var builder = this;
    var cmdHandler;

    // ARG is a little special, as it's not available in the config data, so
    // even if the ARG is already cached, we run it anyway, otherwise we won't
    // be able to track if the '--build-arg' was matched (see checkBuildArgs).
    if (cmd.ctx.isCached && cmd.name !== 'ARG') {
        // Image is already available.
        builder.log.debug('Command is already cached:', cmd);
        callback();
        return;
    }

    cmdHandler = Builder.commandMap[cmd.name];
    if ((typeof (cmdHandler) === 'undefined')
        || (typeof (cmdHandler.fn) === 'undefined')) {

        callback(new Error('Unknown instruction: ' + cmd.name));
        return;
    }

    builder.log.info('Handling command:', cmd);
    cmdHandler.fn.call(builder, cmd, callback);
};

// The individual file/directory hashes are already built, so this summarizes
// and returns one individual hash that covers all files in the given copyInfos.
function generateHashForCopyInfos(copyInfos) {
    var hash = copyInfos[0].hash;
    if (copyInfos.length > 1) {
        var hashes = copyInfos.map(function copyInfosHashJoin(ci) {
            return ci.hash;
        });
        var hasher = crypto.createHash('sha256');
        hasher.update(hashes.join(','));
        hash = 'multi:' + hasher.digest('hex');
    }
    return hash;
}

// Allow customization after the step is performed.
Builder.prototype.doPostStep = function doPostStep(cmd, callback) {
    var builder = this;
    var image = builder.image;

    // Make a ContainerConfig entry - which seems to be the same as config,
    // except for the cmd entry.
    image.container_config = jsprim.deepCopy(image.config);
    if (!cmd.ctx.isCached) {
        image.container_config.Cmd = builder.getNopCmdForCommand(cmd);
        image.created = (new Date()).toISOString();
    }
    builder.storeImageLayer(cmd);

    callback();
};


Builder.prototype.sendCommandDetails = function sendCommandDetails(cmd) {
    var builder = this;

    var cmdString = getCommandString(cmd);
    builder.emitStdout(util.format('Step %d : %s\n',
                                (builder.stepNo + 1), cmdString));
};


Builder.prototype.sendLayerId = function sendLayerId() {
    var builder = this;
    if (builder.image.id === null) {
        builder.emitStdout(' --->\n');
    } else {
        builder.emitStdout(util.format(' ---> %s\n', builder.getShortId()));
    }
};

Builder.prototype.runOnBuildTriggers =
function runOnBuildTriggers(onBuildTriggers, callback)
{
    var builder = this;

    builder.onBuildTriggers = null; // reset it
    if (!onBuildTriggers || onBuildTriggers.length === 0) {
        callback();
        return;
    }

    // Remove OnBuild triggers from the config when done, since the config
    // will be committed.
    builder.image.config.OnBuild = null;

    // Process ONBUILD triggers.
    builder.emitStdout(util.format('# Executing %d build triggers\n',
        onBuildTriggers.length));

    async.eachSeries(onBuildTriggers, function (trigger, next) {
        builder.log.debug('runOnBuildTriggers: trigger %j', trigger);
        var commands = dockerFileParser.parse(trigger);
        if (commands.length !== 1) {
            next(new Error(util.format('Expected 1 command for OnBuild '
                + 'trigger %j, got %d', trigger, commands.length)));
            return;
        }
        builder.step(commands[0], next);
    }, function onBuildCb(stepErr) {
        // Remove OnBuild triggers from the config when done, since the
        // config will be committed.
        builder.image.config.OnBuild = null;
        callback(stepErr);
    });
};


/**
 * copyInfo holds information for file copying from the context into the zone.
 */
function copyInfo(builder, origPath, destPath, allowDecompression) {
    this.builder = builder;
    this.origPath     = origPath;  // Path given in Dockerfile.
    this.destPath     = destPath;  // Dest given in Dockerfile.
    this.hash         = '';        // File (or dir) sha256 checksum.
    this.decompress   = allowDecompression; // If file decompress is allowed.
    this.tmpDir       = '';    // Some files will extract info to a tmpDir.
    this.children     = [];    // Child ci entries (for directories);
}

// Abs path to actual context file.
lazyProperty(copyInfo.prototype, 'contextPath',
function copyInfo_contextPath()
{
    var src = path.join(this.builder.contextExtractDir, this.origPath);

    // Sanity check that path is still inside the context extract dir.
    src = fs.realpathSync(src, this.builder.realpathCache);
    var extDirWithSlash = this.builder.contextExtractDir + '/';

    var pathOk = (src.substr(0, extDirWithSlash.length) === extDirWithSlash)
        || (src === this.builder.contextExtractDir);
    if (!pathOk) {
        throw new ForbiddenPathException(
            // Note that there is a deliberate space at the end of this string,
            // to match the docker/docker build test cases.
            util.format('Forbidden path outside the build context: %s ',
                        this.origPath));
    }

    return src;
});

// Return the absolute path (from the container root) to actual context file.
lazyProperty(copyInfo.prototype, 'containerAbsPath',
function copyInfo_containerAbsPath()
{
    return this.contextPath.slice(this.builder.contextExtractDir.length);
});

// Return the basename of the origPath.
lazyProperty(copyInfo.prototype, 'basename',
function copyInfo_basename()
{
    return path.basename(this.containerAbsPath);
});

// Get stat information for the contextPath.
lazyProperty(copyInfo.prototype, 'stat',
function copyInfo_stat()
{
    return fs.statSync(this.contextPath);
});

// Return true if the contextPath is a directory.
lazyProperty(copyInfo.prototype, 'contextPathIsDirectory',
function copyInfo_contextPathIsDirectory()
{
    return this.stat.isDirectory();
});

// Return true if the destPath is a directory.
lazyProperty(copyInfo.prototype, 'destPathIsDirectory',
function copyInfo_destPathIsDirectory()
{
    // Directories must end with a forward slash!
    return this.destPath.slice(-1) === '/';
});

// Abs path to the destination file/directory.
lazyProperty(copyInfo.prototype, 'zoneDestPath',
function copyInfo_zoneDestPath()
{
    // If dest ends with a slash, then it's a directory, else it's a file.
    var dest = path.join(this.builder.containerRootDir, this.destPath);
    if (this.destPathIsDirectory && !this.contextPathIsDirectory) {
        // If the context is a file, join it to the current dest.
        dest = path.join(dest, this.basename);
    }

    // Sanity check that path is still inside the zone root.
    var rootDirWithSlash = this.builder.containerRootDir + '/';
    assert.ok((dest.substr(0, rootDirWithSlash.length) === rootDirWithSlash)
            || (dest === this.builder.containerRootDir));

    return dest;
});

// Generate sha256 checksum of this context file.
lazyProperty(copyInfo.prototype, 'checksum',
function copyInfo_checksum()
{
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


Builder.prototype.getCopyInfoFromOpts = function getCopyInfoFromOpts(opts) {
    return new copyInfo(this, opts.origPath, opts.destPath,
                        opts.allowDecompression);
};


/**
 * Ensure the given directory (full realpath outside of the container) exists
 * or is created when it doesn't exist. When it is created, it will be chown'd
 * by the builder's chownUid/chownGid settings.
 */
Builder.prototype.mkdirpChown = function doMkdirpChown(outsideDir, callback) {
    var builder = this;
    var opts = {
        'uid': builder.chownUid,
        'gid': builder.chownGid,
        'log': builder.log
    };
    utils.mkdirpChown(outsideDir, opts, callback);
};


/**
 * Given an absolute target container path, resolves all directory symlinks to
 * and returns the real container path (i.e. no symlinks). Guarantees that the
 * resulting path remains underneath the given root directory.
 */
function getRealpathFromRootDir(target, outsideRootDir, loopCount) {
    if (typeof (loopCount) === 'undefined') {
        loopCount = 0;
    } else if (loopCount > 20) {
        // Bail out - too many symlinks.
        throw new Error('too many symlinks in desination path: ' + target);
    }
    var containerPath = '/';
    var hadTrailingSlash = (target.slice(-1) === '/');
    var i;
    var lastContainerPath;
    var lstat;
    var outsidePath = outsideRootDir; // full absolute path outside container
    var rootDirWithSlash = outsideRootDir + '/';
    var targetSplit = path.normalize(target).split('/');

    if (targetSplit[0] === '') {
        // Chop first / as that's the root directory.
        targetSplit = targetSplit.slice(1);
    }
    if (targetSplit[targetSplit.length - 1] === '') {
        // Chop last (and empty) directory - i.e. paths that had trailing slash
        targetSplit = targetSplit.slice(0, -1);
    }

    // For every directory inside of the container, check if it's a symlink, and
    // if it is, then find that symlink path relative to the container root.
    for (i = 0; i < targetSplit.length; i++) {
        lastContainerPath = containerPath;
        containerPath = path.join(containerPath, targetSplit[i]);
        outsidePath = path.join(outsideRootDir, containerPath);

        // Assert it's not outside of the container root.
        if ((outsidePath.substr(0, rootDirWithSlash.length)
            !== rootDirWithSlash)
            && (outsidePath !== outsideRootDir)) {

            throw new ForbiddenPathException(
                // Note that there is a deliberate space at the end of this
                // string, to matched the docker/docker build test cases.
                util.format('Forbidden path outside the build context: %s ',
                    target));
        }

        try {
            lstat = fs.lstatSync(outsidePath);
        } catch (e) {
            if (e.code === 'ENOENT') {
                // Doesn't exist - that's fine, it will be created later.
                if ((i+1) < targetSplit.length) {
                    containerPath = path.join(containerPath,
                        targetSplit.slice(i+1).join('/'));
                }
                break;
            }
            throw e;
        }
        if (lstat.isSymbolicLink()) {
            containerPath = fs.readlinkSync(outsidePath);
            // If it's a relative path - then it's from the last dir (i.e. the
            // parent of containerPath).
            if (containerPath[0] !== '/') {
                // Relative from the current directory.
                containerPath = path.join(lastContainerPath, containerPath);
            }
            // Now go and resolve this new path.
            containerPath = getRealpathFromRootDir(containerPath,
                outsideRootDir, loopCount + 1);
        }
    }

    if (hadTrailingSlash && containerPath.slice(-1) !== '/') {
        containerPath += '/';
    }

    return containerPath;
}


/**
 * Given a target container path, resolve all directory symlinks to the absolute
 * container path (i.e. no symlinks) and ensures the resulting path remains
 * inside the container root.
 */
Builder.prototype.containerRealpath = function containerRealpath(target) {
    var builder = this;
    var containerPath = target;
    if (containerPath[0] !== '/') {
        // The path is relative to the current WorkingDir - make it absolute.
        containerPath = path.join((builder.image.config.WorkingDir || '/'),
            containerPath);
    }
    return getRealpathFromRootDir(containerPath, builder.containerRootDir);
};


/**
 * Loop through each src file and calculate the info we need to
 * do the copy (e.g. hash value if cached).  Don't actually do
 * the copy - that will be done later if necessary (i.e. not cached).
 */
Builder.prototype.getCopyInfo = function getCopyInfo(cmd, opts, callback) {
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
    var filepaths = cmd.args.slice(0, -1);  // Last one is the destination.
    var dest = cmd.args[cmd.args.length - 1]; // last one is always the dest
    // Twiddle the destPath when its a relative path - meaning, make it
    // relative to the WORKINGDIR.
    if (dest.charAt(0) !== '/') {
        dest = path.join(builder.image.config.WorkingDir, dest);
    }

    var resolvedDest;
    try {
        resolvedDest = builder.containerRealpath(dest);
    } catch (e) {
        // Unexpected error accessing that path - abort.
        callback(e);
        return;
    }

    var calcOpts = {
        origPath: '', // Updated in mapFn
        destPath: resolvedDest,
        allowRemote: opts.allowRemote,
        allowDecompression: opts.allowDecompression,
        allowWildcards: true
    };

    function cciMapFn(fpath, cb) {
        calcOpts.origPath = fpath;
        builder.calculateCopyInfo(cmd, calcOpts, cb);
    }

    function flattenResults(err, cInfoArrays) {
        if (err) {
            callback(err);
            return;
        }
        // Flatten arrays into just one array.
        var copyInfos = cInfoArrays.reduce(function (a, b) {
            return a.concat(b);
        });

        if (copyInfos.length === 0) {
            callback(new Error('No source files were specified'));
            return;
        }

        if (copyInfos.length > 1 && dest[dest.length - 1] != '/') {
            callback(new Error(util.format(
                'When using %s with more than one source '
                + 'file, the destination must be a '
                + 'directory and end with a /', cmd.name)));
            return;
        }

        callback(null, copyInfos);
    }

    async.mapSeries(filepaths, cciMapFn, flattenResults);
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

    var builder = this;

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

        builder.infoForRemoteCopy(cmd, u, opts, callback);
        return;
    }

    // Deal with wildcards
    if (opts.allowWildcards && utils.containsWildcards(opts.origPath)) {
        builder.infoForWildcardCopy(cmd, opts, callback);
        return;
    }

    // Must be a dir or a file in the context.
    var ci = builder.getCopyInfoFromOpts(opts);

    // First, make sure the context file exists.
    try {
        var isDirectory = ci.contextPathIsDirectory;
    } catch (e) {
        if (e.code === 'ENOENT') {
            // Convert to the wanted docker error message string.
            callback(new Error(util.format('stat %s: no such file or directory',
                                        ci.origPath)));
        } else {
            callback(e);
        }
        return;
    }

    try {
        // Deal with the single file case
        if (!isDirectory) {
            builder.infoForFileCopy(ci, callback);
            return;
        }
        // Must be a directory.
        builder.infoForDirectoryCopy(ci, callback);
    } catch (ex) {
        if (ex instanceof ForbiddenPathException) {
            callback(ex);
            return;
        }
        throw ex;
    }
};

Builder.prototype.infoForFileCopy = function infoForFileCopy(ci, callback)
{
    this.log.debug('infoForFileCopy:', ci.contextPath);
    ci.hash = 'file:' + ci.checksum;
    callback(null, [ci]);
};

Builder.prototype.infoForDirectoryCopy =
function infoForDirectoryCopy(ci, callback)
{
    var log = this.log;
    ci.hash = ci.origPath; // Fallback case where there are no child entries.

    this.loadChildInfo(ci, function (err) {
        if (err) {
            callback(err);
            return;
        }

        var cciHashes = ci.getAllChildFiles().map(function childHash_map(cci) {
            log.debug('infoForDirectoryCopy: file: %j, checksum: %j',
                cci.contextPath, cci.checksum);
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
    var builder = this;
    var copyInfos;
    var i;
    var isLastPattern;
    var j;
    var log = builder.log;
    var matchRe;
    var newPaths;
    var paths;
    var pattern = opts.origPath;
    var patternSplit = pattern.split('/');

    /**
     * Split the match string using '/' separators, then walk the target dir
     * (starting at the base dir) and check for matches. Return matches in the
     * copyInfo format.
     */
    log.debug('opts: ', opts);

    function getMatchedContainerPaths(contDir, regex, allowFilePaths) {
        // Ensure the container dir remains inside the container.
        contDir = getRealpathFromRootDir(contDir, builder.contextExtractDir);

        var outsideDir = path.join(builder.contextExtractDir, contDir);
        var names = fs.readdirSync(outsideDir);
        // Filter names down to ones that match the regex.
        names = names.filter(function _wildcardMatchEntriesFilterFn(name) {
            if (regex.test(name)) {
                return true;
            }
            return false;
        });
        // Now only return directories, unless this is the last part of path.
        names = names.filter(function _wildcardMatchEntriesFilterFn2(name) {
            var outPath = path.join(outsideDir, name);
            var lstat = fs.lstatSync(outPath);
            if (lstat.isSymbolicLink()) {
                outPath = getRealpathFromRootDir(path.join(contDir, name),
                    builder.contextExtractDir);
                lstat = fs.lstatSync(outPath);
            }
            if (lstat.isDirectory() || (allowFilePaths && lstat.isFile())) {
                return true;
            }
            return false;
        });

        return names.map(function _wildcardMatchEntriesMapFn(name) {
            return path.join(contDir, name);
        });
    }

    log.debug('infoForWildcardCopy: patternSplit: %j', patternSplit);
    paths = ['/'];
    for (i = 0; i < patternSplit.length; i++) {
        isLastPattern = (i === (patternSplit.length - 1));
        matchRe = minimatch.makeRe(patternSplit[i]);
        newPaths = [];
        for (j = 0; j < paths.length; j++) {
            newPaths = newPaths.concat(getMatchedContainerPaths(paths[j],
                matchRe, isLastPattern));
        }
        log.debug('infoForWildcardCopy: %d paths found for pattern %d - %j',
            newPaths.length, i, newPaths);
        paths = newPaths;
    }

    // We've got the matched paths, now turn into copyInfos and get the hash
    // info (and child info for directories).
    copyInfos = [];
    async.each(paths, function (containerPath, next) {
        var ci = builder.getCopyInfoFromOpts({
            origPath: containerPath,
            destPath: opts.destPath,
            allowDecompression: opts.allowDecompression
        });
        copyInfos.push(ci);
        try {
            // Deal with file or directory.
            if (ci.contextPathIsDirectory) {
                builder.infoForDirectoryCopy(ci, next);
                return;
            }
            // Must be a file.
            builder.infoForFileCopy(ci, next);
        } catch (ex) {
            next(ex);
        }

    }, function _returnResult(err) {
        if (err) {
            callback(err);
            return;
        }
        log.debug('infoForWildcardCopy: %d cInfos returned', copyInfos.length);
        callback(null, copyInfos);
    });
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


Builder.prototype.performCopy = function performCopy(cmd, copyInfos, callback) {
    var builder = this;
    var compressionType;
    var extractAsTarfile = false;
    var log = builder.log;

    log.debug('performCopy: %d copyInfos', copyInfos.length);

    async.waterfall([
        // Special handling for ADD with a tar file.
        function detectAddTarFile(next) {
            if (cmd.name !== 'ADD' || copyInfos.length !== 1
                || copyInfos[0].contextPathIsDirectory) {

                next();
                return;
            }

            var contextPath = copyInfos[0].contextPath;
            assert.string(contextPath, 'contextPath');

            if (contextPath.slice(-4) === '.tar') {
                extractAsTarfile = true;
                next();
                return;
            }

            magic.compressionTypeFromPath(contextPath, function (err, cType) {
                if (err) {
                    next(err);
                    return;
                }
                compressionType = cType; // one of: null, bzip2, gzip, xz
                if (cType) {
                    extractAsTarfile = true;
                }
                next();
            });
        },
        function doCopyFiles(next) {
            var extractDir = copyInfos[0].zoneDestPath;
            if (extractAsTarfile) {
                if (copyInfos[0].destPathIsDirectory) {
                    // zoneDestPath is currently a filepath (i.e.
                    // /dest/myfile.tar), we just want the directory instead.
                    extractDir = path.dirname(extractDir);
                }
                log.info('Extracting tarfile in %s, compression: %s',
                    extractDir, compressionType || 'none');

                var event = {
                    callback: next,
                    compression: compressionType,
                    extractDir: extractDir,
                    tarfile: copyInfos[0].contextPath,
                    type: 'extract_tarfile'
                };
                builder.emitTask(event);
                return;
            }

            var copyFn = builder.doCopy.bind(builder);
            async.eachSeries(copyInfos, copyFn, next);
        }
    ], callback);
};

Builder.prototype.doCopy = function doCopy(ci, callback)
{
    var builder = this;

    if (ci.contextPathIsDirectory) {
        builder.doCopyOneDirectory(ci, callback);
        return;
    }
    builder.doCopyOneFile(ci, callback);
};

Builder.prototype.doCopyOneFile = function doCopyOneFile(ci, callback)
{
    var builder = this;
    var parentDir = path.dirname(ci.zoneDestPath);

    builder.log.debug('copying file %j to %j', ci.contextPath, ci.zoneDestPath);
    // Ensure parent directory exists, then copy file to it.
    builder.mkdirpChown(parentDir, function (err) {
        if (err) {
            callback(err);
            return;
        }

        //var opts = {
        //    'uid': builder.chownUid,
        //    'gid': builder.chownGid,
        //    'log': builder.log
        //};
        //utils.fileCopy(ci.contextPath, ci.zoneDestPath, opts, callback);
        //return;

        function onExtractedCb(err2, result) {
            if (err2) {
                callback(err2);
                return;
            }
            fs.chown(ci.zoneDestPath, builder.chownUid, builder.chownGid,
                callback);
        }

        // Extract   /foo/bar/baz.txt    /dir/boo.txt
        // Remove leading slash to have a relative path (from root dir).
        var containerRelativePath = ci.containerAbsPath.slice(1);
        var stripDirCount = containerRelativePath.split('/').length - 1;

        var event = {
            callback: onExtractedCb,
            extractDir: parentDir,
            paths: [containerRelativePath],
            destPaths: [ci.zoneDestPath.slice(1)],
            stripDirCount: stripDirCount,
            tarfile: builder.contextFilepath,
            type: 'extract_tarfile'
        };

        var srcBasename = path.basename(containerRelativePath);
        var destBasename = path.basename(ci.zoneDestPath);
        if (srcBasename !== destBasename) {
            // Regex escape the name and make a pattern like:
            // '/filename$/newname/'
            event.replacePattern = '/' + utils.escapeRegExp(srcBasename) + '$/'
                // Destination needs to have backslashes escaped.
                + destBasename.replace(/\\/g, '\\\\').replace(/\//, '\\/')
                + '/';
        }

        builder.emitTask(event);
    });
};

Builder.prototype.doCopyOneDirectory = function doCopyOneDirectory(ci, callback)
{
    var builder = this;
    builder.mkdirpChown(ci.zoneDestPath, function (err) {
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

Builder.prototype.reprovisionImage =
function reprovisionImage(cmd, imageName, callback)
{
    var builder = this;
    var log = builder.log;

    log.info('reprovisionImage: %s', imageName);

    function reprovisionCb(err, result) {
        if (err) {
            callback(err);
            return;
        }
        // This image config becomes the builder's base config.
        // Note: result.image is in docker inspect format.
        builder.image.config = result.image.Config;
        builder.image.container_config = result.image.ContainerConfig;
        // Re-apply any cliLabels, otherwise they'll be lost.
        if (builder.isLastStep() && !jsprim.isEmpty(builder.cliLabels)) {
            builder.log.debug('re-adding builder cliLabels: %j',
                builder.cliLabels);
            builder.addConfigMap(builder.cliLabels, 'Labels');
        }

        var event2 = {
            callback: function reprovisionImageEventCb(err2) {
                callback(err2, result.image);
            },
            cmdName: cmd.name
        };
        builder.emit('image_reprovisioned', event2);
    }

    var event = {
        callback: reprovisionCb,
        cmdName: cmd.name,
        imageName: imageName,
        type: 'image_reprovision'
    };
    builder.emitTask(event);
};

Builder.prototype.handleFromImage = function handleFromImage(cmd, callback)
{
    var builder = this;

    builder.reprovisionImage(cmd, cmd.args, function reprovisionCb(err, image) {
        // Note: image is in docker inspect format.
        if (err) {
            callback(err);
            return;
        }
        var config = builder.image.config;

        builder.setImageId(image.Id);
        builder.setParentId(config.Image || null);
        builder.onBuildTriggers = config.OnBuild;
        // Remove OnBuild triggers from the config when done, since the config
        // will be committed.
        config.OnBuild = null;

        callback();
    });
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
    var config = builder.image.config;
    // The env needs to combine the config env and the build args.
    var env = getMergedEnvArgArray(config.Env || [], builder.buildArgs);
    var event = {
        callback: cb,
        cmd: cmd.args,
        workdir: config.WorkingDir || '/',
        env: env,
        type: 'run',
        user: config.User
    };
    builder.emitStdout(util.format(' ---> Running in %s\n',
                                builder.getShortId(builder.zoneUuid)));
    builder.emitTask(event);
};


module.exports = {
    Builder: Builder
};
