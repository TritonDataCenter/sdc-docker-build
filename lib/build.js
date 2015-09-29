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
var lazyProperty = require('lazy-property');
var libuuid = require('libuuid');
var minimatch = require('minimatch');
var mkdirp = require('mkdirp');
var once = require('once');

var utils = require('./utils');


var MAX_DOCKERFILE_LENGTH = 10 * 1024 * 1024;  // 10 Mb


/**
 * Builder takes a docker context file and creates a docker image.
 *
 * Events emitted:
 *  'end(err)' - when the build is finished, err indicates success or failure.
 *  'event(MessageEvent)' - for notifying of events that occur during the build.
 */
function Builder(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.workDir, 'opts.workDir');
    assert.string(opts.containerRootDir, 'opts.containerRootDir');
    assert.string(opts.contextFilepath, 'opts.contextFilepath');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.uuid, 'opts.uuid');

    // Allow emitting of events.
    EventEmitter.call(this);

    this.workDir = opts.workDir;
    this.containerRootDir = opts.containerRootDir;
    this.contextFilepath = opts.contextFilepath;
    this.log = opts.log;
    this.zoneUuid = opts.uuid;

    // TODO: Use a unique name for contextDir.
    this.contextDir = path.join(this.workDir, 'context');
    this.contextExtractDir = path.join(this.contextDir, 'extracted');
    this.layers = [];  // Generated image layers during build.
    this.realpathCache = {}; // Used to cache realpath lookups.

    this.image = {
        'architecture': 'amd64',
        'config': {
            'WorkingDir': ''
        },
        'os': 'linux',
        'parent': null
    };
    this.config = this.image.config;
    this.currentId = null;
}

util.inherits(Builder, EventEmitter);

Builder.prototype.start = function () {
    var builder = this;
    var log = builder.log;

    async.waterfall([
        function extract(next) {
            builder.extractContext(next);
        },
        function readDockerfile(next) {
            builder.readDockerfile(next);
        },
        function parse(dockerfileContents, next) {
            dockerfileContents = String(dockerfileContents);
            var commands = dockerFileParser.parse(dockerfileContents);
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
                        builder.handleCommand.bind(builder),
                        function (err) {
                            cb(err);
                        });
                },
                function runOnBuildCommands(cb) {
                    log.debug('Running %d onbuild commands',
                        onBuildCommands.length);
                    async.eachSeries(onBuildCommands,
                        builder.handleCommand.bind(builder),
                        function (err) {
                            cb(err);
                        });
                }
            ], next);
        },
        function addExtras(next) {
            log.debug('addExtras');
            builder.image.created = (new Date()).toISOString();
            next();
        }
    ], function (err) {
        if (err) {
            log.error(err);
        }
        log.debug('Final image object', builder.image);
        builder.emit('end', err);
    });
};

Builder.prototype.emitError = function (msg) {
    // TODO
    this.log.error(msg);
    throw new Error('Not implemented: emitError');
};

Builder.prototype.emitTask = function (event, callback) {
    this.emit('task', event);
};

Builder.prototype.extractContext = function (callback) {
    var builder = this;
    var log = builder.log;
    log.debug('Extracting docker context to:', builder.contextExtractDir);

    mkdirp(builder.contextExtractDir, function (err) {
        if (err) {
            callback(err);
            return;
        }
        // Ensure the extraction dir is the full real path.
        builder.contextExtractDir = fs.realpathSync(builder.contextExtractDir,
                                                    builder.realpathCache);

        // XXX: Not sure I can rely on chroot-gtar being on the CN?
        var command = util.format(
            '/usr/img/sbin/chroot-gtar %s %s %s none',
            builder.contextDir,
            path.basename(builder.contextExtractDir),
            builder.contextFilepath);
        log.debug('chroot-gtar extraction command: ', command);

        child_process.exec(command, function (error, stdout, stderr) {
            if (error) {
                log.error('chroot-gtar error:', error, ', stderr:', stderr);
            }
            callback(error);
        });
    });
};

Builder.prototype.readDockerfile = function (callback) {
    var dockerfilePath = path.join(this.contextExtractDir, 'Dockerfile');
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

Builder.prototype.writeConfig = function (cmd, callback) {
    // Docker images use a 256-bit id value, general uuid's are 128-bits.
    var builder = this;
    builder.log.debug('Writing config for cmd', cmd);
    var uuid1 = libuuid.create().replace('_', '', 'g');
    var uuid2 = libuuid.create().replace('_', '', 'g');
    var id = uuid1 + uuid2;
    builder.image.id = id;
    builder.image.parent = builder.currentId;
    builder.currentId = id;

    var configPath = path.join(builder.workDir, id + '.config');
    fs.writeFile(configPath, JSON.stringify(builder.image), function (err) {
        if (err) {
            callback(err);
            return;
        }
        builder.layers.push({ id: id, configPath: configPath, snapshot: null });
        callback();
    });
};

Builder.prototype.checkForCacheHit = function (cmd) {
    // TODO: Implement caching.
    return null;
};

Builder.prototype.addConfigMap = function (cmd, propName) {
    var config = this.config;

    Object.keys(cmd.args).forEach(function (key) {
        if (!config.hasOwnProperty(propName)) {
            config[propName] = {};
        }
        config[propName][key] = cmd.args[key];
    });
};

Builder.prototype.addConfigEnvArray = function (cmd, propName) {
    var config = this.config;

    Object.keys(cmd.args).forEach(function (key) {
        if (!config.hasOwnProperty(propName)) {
            config[propName] = [];
        }
        config[propName].push(key + '=' + cmd.args[key]);
    });
};

Builder.prototype.cmdAdd = function (cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    this.addContextToContainer(cmd, {
        allowRemote: (cmd.name === 'ADD'),
        allowDecompression: (cmd.name === 'ADD')
    }, callback);
};

Builder.prototype.cmdCmd = function (cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    this.config.Cmd = cmd.args.slice();  // a copy
    callback();
};

Builder.prototype.cmdCopy = function (cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    // Same as ADD command, but less sugar.
    this.cmdAdd(cmd, callback);
};

Builder.prototype.cmdFrom = function (cmd, callback) {
    assert.string(cmd.args, 'FROM argument should be a string');
    if (cmd.args === 'scratch') {
        // Nothing to do.
        callback();
        return;
    }
    callback(new Error('Not implemented: FROM handling'));
};

Builder.prototype.cmdEntrypoint = function (cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    this.config.Entrypoint = cmd.args.slice();  // a copy
    callback();
};

Builder.prototype.cmdEnv = function (cmd, callback) {
    assert.object(cmd.args, cmd.name + ' argument should be an object');
    this.addConfigEnvArray(cmd, 'Env');
    callback();
};

Builder.prototype.cmdLabel = function (cmd, callback) {
    assert.object(cmd.args, cmd.name + ' argument should be an object');
    this.addConfigMap(cmd, 'Label');
    callback();
};

Builder.prototype.cmdMaintainer = function (cmd, callback) {
    assert.string(cmd.args, cmd.name + ' argument should be a string');
    this.image.author = cmd.args;
    callback();
};

Builder.prototype.cmdRun = function (cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    this.runContainerCommand(cmd, callback);
};

Builder.prototype.cmdUser = function (cmd, callback) {
    assert.string(cmd.args, cmd.name + ' argument should be a string');
    this.config.User = cmd.args;
    callback();
};

Builder.prototype.cmdVolume = function (cmd, callback) {
    assert.arrayOfString(cmd.args, cmd.name + ' argument should be an array');
    if (!this.config.hasOwnProperty('Volumes')) {
        this.config.Volumes = [];
    }
    this.config.Volumes = this.config.Volumes.concat(cmd.args);
    callback();
};

Builder.prototype.cmdWorkdir = function (cmd, callback) {
    assert.string(cmd.args, cmd.name + ' argument should be a string');
    this.config.WorkingDir = cmd.args;
    // Trim trailing slash.
    while (this.config.WorkingDir.slice(-1) === '/') {
        this.config.WorkingDir = this.config.WorkingDir.slice(0, -1);
    }
    callback();
};

Builder.prototype.cmdNotImplemented = function (cmd, callback) {
    callback(new Error('Not implemented: ' + cmd.name));
};

Builder.commandMap = {
    'ADD':        Builder.prototype.cmdAdd,
    'CMD':        Builder.prototype.cmdCmd,
    'COPY':       Builder.prototype.cmdCopy,
    'ENTRYPOINT': Builder.prototype.cmdEntrypoint,
    'ENV':        Builder.prototype.cmdEnv,
    'EXPOSE':     Builder.prototype.cmdNotImplemented,
    'FROM':       Builder.prototype.cmdFrom,
    'LABEL':      Builder.prototype.cmdLabel,
    'MAINTAINER': Builder.prototype.cmdMaintainer,
    'ONBUILD':    Builder.prototype.cmdNotImplemented,
    'RUN':        Builder.prototype.cmdRun,
    'USER':       Builder.prototype.cmdUser,
    'VOLUME':     Builder.prototype.cmdVolume,
    'WORKDIR':    Builder.prototype.cmdWorkdir
};

Builder.prototype.handleCommand = function (cmd, callback) {
    var cmdHandlerFn = Builder.commandMap[cmd.name];
    var builder = this;
    if (typeof (cmdHandlerFn) === 'undefined') {
        callback(new Error('Unhandled command: ' + cmd));
        return;
    }
    builder.log.debug('Handling command:', cmd);
    cmdHandlerFn.call(builder, cmd, function (err) {
        if (err) {
            callback(err);
            return;
        }
        builder.writeConfig(cmd, callback);
    });
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
}

// Abs path to actual context file.
lazyProperty(copyInfo.prototype, 'contextPath', function () {
    var src = path.join(this.builder.contextExtractDir, this.origPath);

    // Sanity check that path is still inside the context extract dir.
    src = fs.realpathSync(src, this.builder.realpathCache);
    var extDir = this.builder.contextExtractDir + '/';
    assert.ok(src.substr(0, extDir.length) === extDir);

    return src;
});

// Return true if the contextPath is a directory.
lazyProperty(copyInfo.prototype, 'contextPathIsDirectory', function () {
    return fs.statSync(this.contextPath).isDirectory();
});

// Abs path to the destination file/directory.
lazyProperty(copyInfo.prototype, 'zoneDestPath', function () {
    // If dest ends with a slash, then it's a directory, else it's a file.
    var dest = path.join(this.builder.containerRootDir, this.destPath);
    if (this.destPath.slice(-1) === '/') {
        dest = path.join(dest, this.origPath);
    }

    // Sanity check that path is still inside the zone root.
    var rootDir = this.builder.containerRootDir + '/';
    assert.ok(dest.substr(0, rootDir.length) === rootDir);

    return dest;
});


Builder.prototype.getCopyInfoFromOpts = function (opts) {
    return new copyInfo(this, opts.origPath, opts.destPath,
                        opts.allowDecompression);
};

Builder.prototype.addContextToContainer = function (cmd, opts, callback) {
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
            var mapFn = function (fpath, cb) {
                calcOpts.origPath = fpath;
                builder.calculateCopyInfo(cmd, calcOpts, cb);
            };
            var filepaths = cmd.args.slice(0, -1);
            async.mapSeries(filepaths, mapFn, function (err, cInfoArrays) {
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

        }, function doCopy(next) {
            // Do the copy/add.
            var copyFn = builder.doCopy.bind(builder);
            async.eachSeries(copyInfos, copyFn, next);
        }
    ], callback);
};

Builder.prototype.calculateCopyInfo = function (cmd, opts, callback) {
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
        && opts.origPath.length > 1)
    {
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

    // Deal with the single file case
    if (!ci.contextPathIsDirectory) {
        this.infoForFileCopy(ci, callback);
        return;
    }

    // Must be a directory.
    this.infoForDirectoryCopy(ci, callback);
};

Builder.prototype.infoForFileCopy = function (ci, callback) {
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

Builder.prototype.infoForWildcardCopy = function (cmd, opts, callback) {
    var subfiles = [];
    var absOrigPath = path.join(this.contextExtractDir, opts.origPath);

    // Add a trailing / to make sure we only pick up nested files under
    // the dir and not sibling files of the dir that just happen to
    // start with the same chars
    if (absOrigPath.slice(-1) !== '/') {
        absOrigPath += '/';
    }

    // Need path w/o / too to find matching dir w/o trailing /
    var absOrigPathNoSlash = absOrigPath.slice(-1);

    var fsums = this.getFileChecksums();
    var fileInfo;
    var absFile;
    var i;

    var ci = this.getCopyInfoFromOpts(opts);
    ci.hash = opts.origPath;

    for (i = 0; i < fsums.length; i++) {
        fileInfo = fsums[i];

        absFile = path.join(this.contextExtractDir, fileInfo.name);
        // Any file in the context that starts with the given path will be
        // picked up and its hashcode used.  However, we'll exclude the
        // root dir itself.  We do this for a coupel of reasons:
        // 1 - ADD/COPY will not copy the dir itself, just its children
        //     so there's no reason to include it in the hash calc
        // 2 - the metadata on the dir will change when any child file
        //     changes.  This will lead to a miss in the cache check if that
        //     child file is in the .dockerignore list.
        if ((absFile.substr(0, absOrigPath.length) === absOrigPath)
            && absFile !== absOrigPathNoSlash)
        {
            subfiles.push(fileInfo.checksum);
        }
    }
    subfiles.sort();
    var hasher = crypto.createHash('sha256');
    hasher.update(subfiles.join(','));
    ci.hash = 'dir:' + hasher.digest('hex');

    callback(null, [ci]);
};

Builder.prototype.infoForWildcardCopy = function (cmd, opts, callback) {
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

Builder.prototype.infoForRemoteCopy = function (cmd, u, opts, callback) {
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

Builder.prototype.doCopy = function (ci, callback) {
    this.log.debug('copying file %j to %j', ci.contextPath, ci.zoneDestPath);
    utils.fileCopy(ci.contextPath, ci.zoneDestPath, callback);
};

Builder.prototype.runContainerCommand = function (cmd, callback) {
    var builder = this;
    var log = builder.log;
    var event = {
        callback: callback,
        cmd: cmd.args,
        cwd: builder.config.WorkingDir || '/',
        env: build.config.env,
        type: 'command',
        user: user
    };
    this.emitTask(event);
}


module.exports = {
    Builder: Builder
};
