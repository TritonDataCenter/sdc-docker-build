/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */
var child_process = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var jsprim = require('jsprim');
var mkdirp = require('mkdirp');
var mod_uuid = require('uuid');
var rimraf = require('rimraf');
var tape = require('tape');
var tar = require('tar-stream');
// Track and cleanup temporary files at exit.
var temp = require('temp').track();

var dockerbuild = require('../lib/build');
var utils = require('../lib/utils');

// - Globals

var testContextDir = path.join(__dirname, 'files');
var tarExe = 'tar';
if (process.platform === 'sunos') {
    tarExe = 'gtar';
}

// - Test helpers.

function testBuildContents(t, fileAndContentsMap, opts, callback) {
    createTempTarFile(fileAndContentsMap, function (tarErr, contextFilepath) {
        if (tarErr) {
            callback(new Error('Failed to create tar archive: ' + tarErr));
            return;
        }
        testBuildContext(t, contextFilepath, opts, callback);
    });
}

function testBuildContext(t, fpath, opts, callback) {
    if (typeof (callback) === 'undefined' && typeof (opts) === 'function') {
        callback = opts;
        opts = {};
    }

    // Ensure context tarfile exists.
    fs.statSync(fpath);

    var ringbuffer = new bunyan.RingBuffer({ limit: 100 });
    var log = bunyan.createLogger({
        name: ' ',
        streams: [
            //{
            //    level: 'debug',
            //    stream: process.stdout
            //},
            {
                level: 'debug',
                type: 'raw',
                stream: ringbuffer
            }
        ]
    });
    log.rbuffer = ringbuffer;

    var existingImages = opts.existingImages || [];
    var uuid = mod_uuid.v4();
    var tmpDir = os.tmpDir();
    // Ensure the tmpDir is the full real path.
    tmpDir = fs.realpathSync(tmpDir);
    var zoneDir = path.join(tmpDir, uuid);
    t.zoneDir = zoneDir;
    fs.mkdirSync(zoneDir);
    var zoneRoot = path.join(zoneDir, 'root');
    fs.mkdirSync(zoneRoot);
    var configDir = path.join(zoneDir, 'config');
    fs.mkdirSync(configDir);

    var buildOpts = {
        log: log,
        uuid: uuid,
        commandType: 'build',
        contextFilepath: fpath,
        workDir: configDir,
        containerRootDir: zoneRoot
    };

    var messages = [];
    var tasks = [];

    var builder = new dockerbuild.Builder(buildOpts);

    builder.on('message', function (event) {
        messages.push(event);
    });

    builder.on('image_reprovisioned', function (event) {
        event.callback.apply(builder, [null]);
    });

    builder.on('task', function (task) {
        var result = [null];

        if (task.type === 'extract_tarfile') {
            handleExtractTarfile(builder, task, opts.ignoreTarExtractionError);
            return;
        }

        if (task.type === 'find_cached_image') {
            result = [null, existingImages.filter(function (img) {
                return task.cmd === img.image.container_config.Cmd.join(' ');
            })[0]];
            task.callback.apply(builder, result);
            return;
        }

        if (t.hasOwnProperty('buildTaskHandler')) {
            result = t.buildTaskHandler(builder, task);

        } else if (task.type === 'image_reprovision') {
            // Return a result for the busybox image task.
            result = [null, {
                'digest': 'sha256:cfa753dfea5e68a24366dfba16e6edf573'
                            + 'daa447abf65bc11619c1a98a3aff54',
                'image': {
                    'config': {
                        'Cmd': [ 'sh' ]
                    },
                    'container_config': {
                        'Cmd': [ '/bin/sh', '-c', '#(nop) CMD ["sh"]' ]
                    },
                    'history': [
                        {
                                'created': '2016-10-07T21:03:58.16783626Z',
                                'created_by': '/bin/sh -c #(nop) ADD file:ced3'
                                    + 'aa7577c8f970403004e45dd91e9240b1e3ee8bd'
                                    + '109178822310bb5c4a4f7 in / '
                            },
                            {
                                'created': '2016-10-07T21:03:58.469866982Z',
                                'created_by': '/bin/sh -c #(nop)  CMD [\'sh\']',
                                'empty_layer': true
                        }
                    ]
                }
            }];
        } else if (task.type === 'run') {
            // Hook up the simple run command handler.
            tasks.push(task);
            simpleRunTaskHandler(builder, task);
            return;
        }

        tasks.push(task);
        if (task.callback) {
            task.callback.apply(builder, result);
        }
    });

    builder.on('end', function (err) {
        var result = {
            builder: builder,
            messages: messages,
            tasks: tasks
        };
        callback(err, result);
    });

    builder.start();
}

function testEnd(t, builder, hadErr) {
    if (hadErr) {
        t.end();
        return;
    }

    // cleanup
    rimraf(t.zoneDir, function (err) {
        if (err) {
            builder.log.error('Failed to cleanup directory %s: %s',
                t.zoneDir, err);
        }
        t.end(err);
    });
}

function verifyFileContents(t, builder, filepath, contents) {
    var fullpath = path.join(builder.containerRootDir, filepath);
    if (!fs.existsSync(fullpath)) {
        t.fail('File ' + filepath + ' does not exist');
    }
    var actualContents = fs.readFileSync(fullpath).toString();
    if (actualContents !== contents) {
        t.equal(actualContents, contents,
            'File contents for ' + filepath + ' do not match');
    }
}

function verifySymlink(t, builder, filepath, details) {
    var fullpath = path.join(builder.containerRootDir, filepath);
    if (fs.readlinkSync(fullpath) !== details.linkname) {
        t.equal(fs.readlinkSync(fullpath), details.linkname,
            'Link names for ' + filepath + ' do not match');
    }
}

function verifyFilesystem(t, builder, containerPath, filesystem) {
    var entry;
    var fullpath = path.join(builder.containerRootDir, containerPath);
    var i;
    var name;
    var relPath;
    var stat;

    // Assert the list of file names are correct.
    var names = fs.readdirSync(fullpath);
    var expectedNames = Object.keys(filesystem).sort();
    t.deepEqual(names, expectedNames, 'Verifying fs ' + containerPath);

    // Assert the file entries are of the expected type and have the correct
    // content.
    for (i = 0; i < names.length; i++) {
        name = names[i];
        entry = filesystem[name];
        relPath = path.join(containerPath, name);
        stat = fs.lstatSync(path.join(fullpath, name));
        if (stat.isDirectory()) {
            assert.object(entry, name);
            verifyFilesystem(t, builder, relPath, entry);
        } else if (stat.isFile()) {
            assert.string(entry, name);
            verifyFileContents(t, builder, relPath, entry);
        } else if (stat.isSymbolicLink()) {
            assert.object(entry, name);
            verifySymlink(t, builder, relPath, entry);
        } else {
            t.fail('Unexpected file type at: ' + relPath);
        }
    }
}

function handleExtractTarfile(builder, event, ignoreTarExtractionError) {
    var callback = event.callback;
    var extractDir = event.extractDir;
    var log = builder.log;
    var tarfile = event.tarfile;

    log.debug('Extracting tarfile in:', extractDir);

    mkdirp(extractDir, function (err) {
        if (err) {
            callback(err);
            return;
        }

        var command = util.format('%s -C %s -xf %s',
            tarExe, extractDir, tarfile);
        if (event.hasOwnProperty('stripDirCount')) {
            command += util.format(' --strip-components=%d',
                event.stripDirCount);
        }
        if (event.hasOwnProperty('replacePattern')) {
            command += util.format(' -s %s', event.replacePattern);
        }
        if (event.hasOwnProperty('paths')) {
            command += util.format(' %s', event.paths.join(' '));
        }

        log.debug('tar extraction command: ', command);

        child_process.exec(command, function (error, stdout, stderr) {
            if (error) {
                log.error('tar error:', error, ', stderr:', stderr);
                if (ignoreTarExtractionError) {
                    callback();
                    return;
                }
            }

            callback(error);
        });
    });
}

function createTarStream(fileAndContents) {
    var pack = tar.pack();

    Object.keys(fileAndContents).forEach(function (name) {
        if (typeof (fileAndContents[name]) === 'object') {
            pack.entry(fileAndContents[name]);
        } else {
            pack.entry({ name: name }, fileAndContents[name]);
        }
    });

    pack.finalize();

    return pack;
}

function createTempTarFile(fileAndContents, callback) {
    temp.open({suffix: '.tar'}, function _tempOpenCb(err, info) {
        if (err) {
            callback(err);
            return;
        }

        // Pipe tar stream to a file and callback when all written.
        var ws = fs.createWriteStream(null, {fd: info.fd});
        ws.on('finish', function () {
            callback(null, info.path);
        });
        var pack = createTarStream(fileAndContents);
        pack.pipe(ws);
    });
}

function convertEnvArrayToObject(envArray) {
    var result = {};
    envArray.forEach(function (entry) {
        var idx = entry.indexOf('=');
        result[entry.slice(0, idx)] = entry.slice(idx+1);
    });
    return result;
}

function simpleRunTaskHandler(builder, task) {
    var callback = task.callback;
    var exitCode = 0;
    var result = [ null, { exitCode: 0 } ];
    var name = task.cmd[2].split(' ')[0];
    var containsVariables = (task.cmd[2].indexOf('$') >= 0);
    if (!containsVariables
        && (name === 'cat'
            || name === 'mkdir'
            || name === '[['
            || name === '['
            || name === 'ln'))
    {
        // Run this command in the context of the build.
        builder.log.debug('running command: ', task.cmd[2]);
        var cwd = path.join(builder.containerRootDir,
                            builder.image.config.WorkingDir || '');
        // Cheat: strip the absolute path marker from the path.
        var cmd = task.cmd[2].replace('/', '');
        var opts = {
            cwd: cwd,
            env: convertEnvArrayToObject(task.env)
        };

        var proc = child_process.exec(cmd, opts,
            function (error, stdout, stderr) {
                if (error) {
                    builder.log.error('cmd error:', error,
                                    ', stderr:', stderr);
                } else if (stdout) {
                    builder.emitStdout(stdout);
                }
                result = [ error, { exitCode: exitCode } ];
                callback.apply(builder, result);
        });
        proc.on('close', function (code) {
            exitCode = code;
        });
    } else {
        callback.apply(builder, result);
    }
}


function dumpLogs(builder) {
    var records = builder.log.rbuffer.records;
    records = records.map(function (log) {
        return util.format('%s: %s', bunyan.nameFromLevel[log.level],
            log.msg);
    });
    if (records.length > 0) {
        console.log('  ---\n');
        console.log('    Last %d log messages:\n', records.length, records);
        console.log('  ...\n');
    }
}


function showError(t, err, builder) {
    t.ifErr(err, 'check build successful');
    if (err) {
        dumpLogs(builder);
        testEnd(t, builder, err);
        return true;
    }
    return false;
}

function getBuildStepOutput(builder, stepNo) {
    var idx = (stepNo-1) - (builder.totalNumSteps - builder.layers.length);
    return util.format(' ---> %s\n',
        builder.getShortId(builder.layers[idx].imageDigest));
}


// -- actual tests

tape('helloWorldRun', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        var builder = result.builder;
        if (showError(t, err, builder)) {
            return;
        }

        var messages = result.messages;
        var vmId = builder.zoneUuid;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 1/4 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2/4 : COPY hello /\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3/4 : CMD /hello\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },
            { type: 'stdout', message: 'Step 4/4 : RUN /hello how are you\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 4) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        var task = result.tasks[0];
        t.assert(task, 'Should have task events');

        var expectedHelloTask = {
            cmd: [ '/hello', 'how', 'are', 'you' ],
            env: [ 'PATH=/usr/local/sbin:/usr/local/bin:'
                + '/usr/sbin:/usr/bin:/sbin:/bin' ],
            type: 'run',
            user: '',
            workdir: '/'
        };
        delete task['callback'];
        t.deepEqual(task, expectedHelloTask, 'check tasks');

        // Ensure the Cmd in ContainerConfig differs slightly from Config.
        var img = builder.layers[2].image;
        t.notDeepEqual(img.container_config.Cmd, img.config.Cmd);

        testEnd(t, builder);
    });
});


tape('busybox', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');
    var buildOpts = {
    };
    // Only root user has the priviledges to create special files during tar
    // extraction (which is needed for the busybox rootfs.tar file).
    if (process.getuid() !== 0) {
        buildOpts['ignoreTarExtractionError'] = true;
    }

    testBuildContext(t, contextFilepath, buildOpts, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 1/4 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2/4 : LABEL version="1.0"\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3/4 : '
                + 'MAINTAINER Jérôme Petazzoni <jerome@docker.com>\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },
            { type: 'stdout', message: 'Step 4/4 : ADD rootfs.tar /\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 4) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        // Check container contents.
        try {
            fs.statSync(path.join(builder.containerRootDir, 'bin', 'busybox'));
        } catch (e) {
            t.fail('/bin/busybox executable does not exist');
        }

        testEnd(t, builder);
    });
});


tape('fromBusyboxLabel', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');
    var opts = {
        'fromBusyboxImage': true
    };

    testBuildContext(t, contextFilepath, opts, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 1/2 : FROM busybox\n' },
            { type: 'stdout', message: ' ---> cfa753dfea5e\n' },
            { type: 'stdout', message: 'Step 2/2 : LABEL sdcdocker="true"\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        testEnd(t, builder);
    });
});


tape('addDirectory', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 1/2 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2/2 : ADD data /data/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        testEnd(t, builder);
    });
});


tape('addDirectoryRoot', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 1/2 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2/2 : COPY . /\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        testEnd(t, builder);
    });
});


tape('addMulti', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 1/2 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2/2 : COPY /foo/bar /other/dir '
                + '/dest/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        // Ensure the files were copied.
        var destDir = path.join(builder.containerRootDir, 'dest');
        try {
            var names = fs.readdirSync(destDir);
            t.deepEqual(names.sort(), ['bar', 'foo']);
        } catch (e) {
            t.fail('couldn\'t fs.readdirSync destDir: ' + destDir);
        }

        testEnd(t, builder);
    });
});


tape('addTarfile', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var vmId = builder.zoneUuid;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 1/14 : FROM busybox\n' },
            { type: 'stdout', message: ' ---> cfa753dfea5e\n' },

            { type: 'stdout', message: 'Step 2/14 : ADD test.tar /\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3/14 : RUN cat /test/foo '
                + '| grep Hi\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: 'Hi\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },

            { type: 'stdout', message: 'Step 4/14 : ADD test.tar /test.tar\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 4) },
            { type: 'stdout', message: 'Step 5/14 : RUN cat /test.tar/test/foo '
                + '| grep Hi\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: 'Hi\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 5) },

            { type: 'stdout', message: 'Step 6/14 : ADD test.tar /unlikely-to-'
                + 'exist\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 6) },
            { type: 'stdout', message: 'Step 7/14 : RUN cat /unlikely-to-exist/'
                + 'test/foo | grep Hi\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: 'Hi\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 7) },

            { type: 'stdout', message: 'Step 8/14 : ADD test.tar /unlikely-to-'
                + 'exist-trailing-slash/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 8) },
            { type: 'stdout', message: 'Step 9/14 : RUN cat /unlikely-to-exist'
                + '-trailing-slash/test/foo | grep Hi\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: 'Hi\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 9) },

            { type: 'stdout', message: 'Step 10/14 : '
                + 'RUN mkdir /existing-directory\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 10) },

            { type: 'stdout', message: 'Step 11/14 : ADD test.tar /existing-'
                + 'directory\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 11) },
            { type: 'stdout', message: 'Step 12/14 : '
                + 'RUN cat /existing-directory/test/foo | grep Hi\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: 'Hi\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 12) },

            { type: 'stdout', message: 'Step 13/14 : ADD test.tar /existing-'
                + 'directory-trailing-slash/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 13) },
            { type: 'stdout', message: 'Step 14/14 : RUN cat '
                + '/existing-directory-trailing-slash/test/foo | grep Hi\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: 'Hi\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 14) },

            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        testEnd(t, builder);
    });
});


tape('addTarfileAsFile', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var vmId = builder.zoneUuid;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 1/3 : FROM busybox\n' },
            { type: 'stdout', message: ' ---> cfa753dfea5e\n' },

            { type: 'stdout', message: 'Step 2/3 : ADD test.tar /test.tar\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3/3 : RUN [[ -d /test.tar ]]\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },

            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        testEnd(t, builder);
    });
});


tape('addWildcard', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');
    var opts = {
        'fromBusyboxImage': true
    };

    testBuildContext(t, contextFilepath, opts, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var vmId = builder.zoneUuid;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 1/10 : FROM busybox\n' },
            { type: 'stdout', message: ' ---> cfa753dfea5e\n' },
            { type: 'stdout', message: 'Step 2/10 : COPY file*.txt /tmp/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3/10 : RUN ls /tmp/file1.txt '
                + '/tmp/file2.txt\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },
            { type: 'stdout', message: 'Step 4/10 : RUN mkdir /tmp1\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 4) },
            { type: 'stdout', message: 'Step 5/10 : COPY dir* /tmp1/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 5) },
            { type: 'stdout', message: 'Step 6/10 : RUN ls /tmp1\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 6) },
            { type: 'stdout', message: 'Step 7/10 : RUN ls /tmp1/dirt '
                + '/tmp1/nested_file /tmp1/nested_dir/nest_nest_file\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 7) },
            { type: 'stdout', message: 'Step 8/10 : RUN mkdir /tmp2\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 8) },
            { type: 'stdout', message: 'Step 9/10 : ADD dir/*dir robots.txt '
                + '/tmp2/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 9) },
            { type: 'stdout', message: 'Step 10/10 : '
                + 'RUN ls /tmp2/nest_nest_file /tmp2/robots.txt\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 10) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        // Make sure the correct files were copied.
        var dirsToCheck = {
            'tmp': {
                expectedNames: [
                    'file1.txt',
                    'file2.txt'
                ]
            },
            'tmp1': {
                expectedNames: [
                    'dirt',
                    'nested_dir',
                    'nested_file'
                ]
            },
            'tmp1/nested_dir': {
                expectedNames: [
                    'nest_nest_file'
                ]
            },
            'tmp2': {
                expectedNames: [
                    'nest_nest_file',
                    'robots.txt'
                ]
            }
        };

        Object.keys(dirsToCheck).some(function (d) {
            var expectedNames = dirsToCheck[d].expectedNames;
            var names;
            try {
                names = fs.readdirSync(path.join(builder.containerRootDir, d));
            } catch (e) {
                t.fail('cannot list /tmp1 directory');
                showError(t, e, builder);
                return true;
            }
            if (!jsprim.deepEqual(names, expectedNames)) {
                t.deepEqual(names, expectedNames,
                    'Incorrect entries copied to ' + d);
                showError(t, new Error('Invalid wildcard copy ' + d), builder);
                return true;
            }
        });

        testEnd(t, builder);
    });
});


tape('addMissingFile', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');
    var opts = {
        'fromBusyboxImage': true
    };

    testBuildContext(t, contextFilepath, opts, function (err, result) {
        var builder = result.builder;
        var expectedErr = 'stat robots.txt: no such file or directory';
        if (!err) {
            t.fail('Expected a build error');
        } else if (String(err).indexOf(expectedErr) === -1) {
            t.fail('Expected "robots.txt" missing error, got' + err);
        }

        testEnd(t, builder);
    });
});


// DOCKER-918: Test copying a file to a directory, but leave out the trailing
// slash. Following docker/docker this should be allowed.
tape('copy to dir without trailing slash', function (t) {
    var fileAndContents = {
        'Dockerfile': [
            'FROM busybox',
            'RUN mkdir /adir',
            'COPY file.txt /adir'
        ].join('\n'),
        'file.txt': 'hello'
    };
    testBuildContents(t, fileAndContents, function (err, result) {
        var builder = result.builder;
        if (showError(t, err, builder)) {
            return;
        }

        var expectedFilesystem = {
            'adir': {
                'file.txt': fileAndContents['file.txt']
            }
        };
        verifyFilesystem(t, builder, '/', expectedFilesystem);

        testEnd(t, builder);
    });
});


tape('workdir', function (t) {
    var fileAndContents = {
        'Dockerfile': [
            'FROM scratch',
            'WORKDIR /test',
            'WORKDIR subdir'
        ].join('\n')
    };
    testBuildContents(t, fileAndContents, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        t.equal(builder.image.config.WorkingDir, '/test/subdir');

        testEnd(t, builder);
    });
});


// Ensure the WorkingDir path is correctly normalized.
tape('workdir normpath', function (t) {
    var fileAndContents = {
        'Dockerfile': [
            'FROM scratch',
            'WORKDIR /test/../foo/'
        ].join('\n')
    };
    testBuildContents(t, fileAndContents, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }
        var builder = result.builder;
        t.equal(builder.image.config.WorkingDir, '/foo');
        testEnd(t, builder);
    });
});


tape('entrypoint', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        t.deepEqual(builder.image.config.Entrypoint,
                    [ '/bin/sh', '-c', 'exit 130' ]);

        testEnd(t, builder);
    });
});


tape('expose', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        t.deepEqual(builder.image.config.ExposedPorts, {
            '2374/tcp': {}, '2375/tcp': {},
            '7000/tcp': {},
            '8000/tcp': {}, '8001/tcp': {}, '8002/tcp': {}, '8003/tcp': {},
            '8004/tcp': {}, '8005/tcp': {}, '8006/tcp': {}, '8007/tcp': {},
            '8008/tcp': {}, '8009/tcp': {}, '8010/tcp': {}
        });

        testEnd(t, builder);
    });
});


tape('addFileNonexistingDir', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 1/3 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2/3 : WORKDIR /foo/bar\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3/3 : ADD file.txt .\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        testEnd(t, builder);
    });
});


tape('forbiddenContextPath', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        var builder = result.builder;
        if (!err) {
            t.fail('Expected forbidden path error');
        } else {
            t.ok(String(err).indexOf('Forbidden path outside the build '
                + 'context: ../../') >= 0, 'Expect forbidden path exception');
        }
        testEnd(t, builder);
    });
});


tape('variables', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');
    var opts = {
        'fromBusyboxImage': true
    };

    testBuildContext(t, contextFilepath, opts, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        // Check the command variables were properly updated.
        var builder = result.builder;
        builder.layers.forEach(function (layer, idx) {
            var cmd = layer.cmd;
            if (cmd === null) {
                t.ok(idx <= 1, 'Cmd only null for inherited entries');
                return;
            }
            if (cmd.lineno === 16) {
                t.equal(cmd.name, 'ADD', 'Line 16 should be an ADD command');
                t.deepEqual(cmd.args,
                            ['hello/docker/world', '/docker/world/hello'],
                            'Variable substitution for ADD');
            }
            if (cmd.lineno === 47) {
                t.equal(cmd.name, 'ENV', 'Line 47 should be an ENV command');
                t.deepEqual(cmd.args, { def: 'ABC' },
                    'Variable substitution for ENV');
            }
            if (cmd.lineno === 49) {
                t.equal(cmd.name, 'ENV', 'Line 49 should be an ENV command');
                t.deepEqual(cmd.args, { def: 'DEF' },
                    'Variable substitution for ENV');
            }
        });

        // Check the final image env.
        t.deepEqual(builder.image.config.Env,
            [
                'abc=ABC',
                'def=${abc:}',
                'v1=abc',
                'v2=hi there',
                'v3=boogie nights',
                'v4=with\'quotes too',
                'FROM=hello/docker/world',
                'TO=/docker/world/hello',
                'mypath=/home:/away',
                'e1=bar',
                'e2=bar',
                'e3=',
                'e4=$e1',
                'e5=$e11',
                'ee1=bar',
                'ee2=bar',
                'ee3=',
                'ee4=$ee1',
                'ee5=$ee11',
                'eee1=foo',
                'eee2=foo',
                'eee3=foo',
                'eee4=foo'
            ],
            'Final env');

        testEnd(t, builder);
    });
});


tape('caching', function (t) {
    var contextFilepath = path.join(testContextDir,
        'addFileNonexistingDir.tar');

    var configWorkdir = {
        'AttachStdin': false,
        'AttachStderr': false,
        'AttachStdout': false,
        'Cmd': ['/bin/sh', '-c', '#(nop) WORKDIR /foo/bar'],
        'Domainname': '',
        'Entrypoint': null,
        'Env': null,
        'Hostname': '',
        'Image': null,
        'Labels': null,
        'OnBuild': null,
        'OpenStdin': false,
        'StdinOnce': false,
        'Tty': false,
        'User': '',
        'Volumes': null,
        'WorkingDir': '/foo/bar'
    };
    var configAddFile = jsprim.deepCopy(configWorkdir);
    configAddFile.Cmd = ['/bin/sh', '-c', '#(nop) ADD file:8b911a8716b'
        + '94442f9ca3dff20584048536e4c2f47b8b5bb9096cbd43c3432d5 in .'];
    configAddFile.Image = '4672e708a636d238f3af151d33c9aeee14d7eabd60b'
        + '564604d050ec200917177';

    var buildOpts = {
        existingImages: [
            {
                digest: 'sha256:4672e708a636d238f3af151d33c9aeee14d7eabd60b5646'
                    + '04d050ec200917177',
                image: {
                    config: configWorkdir,
                    container_config: configWorkdir,
                    history: [
                        {
                            created: '2016-05-05T18:13:29.963947682Z',
                            created_by: '/bin/sh -c #(nop) ENV foo=bar',
                            empty_layer: true
                        }
                    ]
                }
            },
            {
                digest: 'sha256:6530e406dfec6ea95412afc1495226896eb9c8e0bea695b'
                    + '29102bca1f04ee205',
                image: {
                    config: configAddFile,
                    container_config: configAddFile,
                    history: [
                        {
                            created: '2016-05-05T18:13:29.963947682Z',
                            created_by: '/bin/sh -c #(nop) '
                                + 'WORKDIR /Me Now <me@now.com>/foo/bar',
                            empty_layer: true
                        }
                    ]
                }
            }
        ]
    };

    testBuildContext(t, contextFilepath, buildOpts, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 1/3 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2/3 : WORKDIR /foo/bar\n' },
            { type: 'stdout', message: ' ---> Using cache\n' },
            { type: 'stdout', message: ' ---> 4672e708a636\n' },
            { type: 'stdout', message: 'Step 3/3 : ADD file.txt .\n' },
            { type: 'stdout', message: ' ---> Using cache\n' },
            { type: 'stdout', message: ' ---> 6530e406dfec\n' },
            { type: 'stdout', message: 'Successfully built 6530e406dfec\n' }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        testEnd(t, builder);
    });
});


tape('partialcaching', function (t) {
    var contextFilepath = path.join(testContextDir,
        'addFileNonexistingDir.tar');

    var config = {
        'AttachStdin': false,
        'AttachStderr': false,
        'AttachStdout': false,
        'Cmd': ['/bin/sh', '-c', '#(nop) WORKDIR /foo/bar'],
        'Domainname': '',
        'Entrypoint': null,
        'Env': null,
        'Hostname': '',
        'Image': null,
        'Labels': null,
        'OnBuild': null,
        'OpenStdin': false,
        'StdinOnce': false,
        'Tty': false,
        'User': '',
        'Volumes': null,
        'WorkingDir': '/foo/bar'
    };

    var buildOpts = {
        existingImages: [
            {
                digest: 'sha256:4672e708a636d238f3af151d33c9aeee14d7eabd60b5646'
                    + '04d050ec200917177',
                image: {
                    config: config,
                    container_config: config,
                    history: [
                        {
                            created: '2016-05-05T18:13:29.963947682Z',
                            created_by: '/bin/sh -c #(nop) ENV foo=bar',
                            empty_layer: true
                        }
                    ]
                }
            }
        ]
    };

    testBuildContext(t, contextFilepath, buildOpts, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 1/3 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2/3 : WORKDIR /foo/bar\n' },
            { type: 'stdout', message: ' ---> Using cache\n' },
            { type: 'stdout', message: ' ---> 4672e708a636\n' },
            { type: 'stdout', message: 'Step 3/3 : ADD file.txt .\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        testEnd(t, builder);
    });
});


// tape('addRemote', function (t) {
//    var contextFilepath = path.join(testContextDir, t.name + '.tar');
//
//    testBuildContext(t, contextFilepath, function (err, result) {
//        if (showError(t, err, result.builder)) {
//            return;
//        }
//
//        var builder = result.builder;
//        var messages = result.messages;
//        var expectedMessages = [
//            { type: 'stdout', message: 'Step 1 : FROM scratch\n' },
//            { type: 'stdout', message: ' --->\n' },
//            { type: 'stdout', message: 'Step 2 : ADD https://raw.github'
//                  + 'usercontent.com/joyent/sdc-docker/master/bin/'
//                  + 'sdc-dockeradm /\n' },
//            { type: 'stdout', message: util.format('Successfully built %s\n',
//                                                    builder.getShortId()) }
//        ];
//        t.deepEqual(messages, expectedMessages, 'check message events');
//
//        testEnd(t, builder);
//    });
// });


tape('symlinks', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var outTargetDir = path.join(builder.workDir, 'target');
        mkdirp.sync(outTargetDir);

        var outLink = path.join(builder.containerRootDir, 'linkOut');
        fs.symlinkSync(outTargetDir, outLink, 'dir');

        var linkToLink = path.join(builder.containerRootDir, 'linkToLink');
        fs.symlinkSync('link', linkToLink, 'dir');

        var linkRel = path.join(builder.containerRootDir, 'linkRel');
        fs.symlinkSync('./link', linkRel, 'dir');

        var linkUpDown = path.join(builder.containerRootDir, 'linkUpDown');
        fs.symlinkSync('./target/../link', linkUpDown, 'dir');

        var linkWayUp = path.join(builder.containerRootDir, 'linkWayUp');
        fs.symlinkSync('/../../../../../../../../../..', linkWayUp, 'dir');

        // Now try and break out of the container. There is the following:
        //   /
        //     /target/
        //     /link        >  /target
        //     /linkOut     >  /.../target (path to target outside container)
        //     /linkToLink  >  /link
        //     /linkRel     >  ./link
        //     /linkUpDown  >  ./target/../link
        //     /linkWayUp   > /../../../../../../../../../..
        t.equal(builder.containerRealpath(outLink), outLink);
        t.equal(builder.containerRealpath('/link/'), '/target/');
        t.equal(builder.containerRealpath('/linkToLink/'), '/target/');
        t.equal(builder.containerRealpath('./linkRel/'), '/target/');
        t.equal(builder.containerRealpath('./linkUpDown/'), '/target/');

        mkdirp.sync(builder.containerRootDir, 'play');
        t.equal(builder.containerRealpath('/play/../linkUpDown/'), '/target/');

        builder.image.config.WorkingDir = '/play';
        t.equal(builder.containerRealpath('../linkUpDown/'), '/target/');
        t.equal(builder.containerRealpath('../linkUpDown/..'), '/');
        t.equal(builder.containerRealpath('../linkUpDown/../../../../'), '/');
        t.equal(builder.containerRealpath('../linkUpDown/../linkRel/../'
            + 'linkToLink/a/b/c/d'), '/target/a/b/c/d');
        t.equal(builder.containerRealpath('/../../../../../../../../../foo/'),
            '/foo/');
        t.equal(builder.containerRealpath('/linkWayUp'), '/');
        t.equal(builder.containerRealpath('/linkWayUp/foo/bar'), '/foo/bar');

        testEnd(t, builder);
    });
});


tape('symlinkMissing', function (t) {
    var fileAndContents = {
        'Dockerfile': [
            'FROM busybox',
            'ADD config /home/config/',
            'ADD config/theMissingLink /myNewMissingLink'
        ].join('\n'),
        'config/theMissingLink': {
            name: 'config/theMissingLink',
            type: 'symlink',
            linkname: '/missing/directory/path'
        }
    };

    testBuildContents(t, fileAndContents, function (err, result) {
        var builder = result.builder;
        if (showError(t, err, builder)) {
            return;
        }

        var expectedFilesystem = {
            'home': {
                'config': {
                    'theMissingLink': fileAndContents['config/theMissingLink']
                }
            },
            'myNewMissingLink': fileAndContents['config/theMissingLink']
        };
        verifyFilesystem(t, builder, '/', expectedFilesystem);

        testEnd(t, builder);
    });
});


tape('FROM must be first', function (t) {
    var fileAndContents = {
        'Dockerfile': 'MAINTAINER me\nFROM busybox\n'
    };
    testBuildContents(t, fileAndContents, function (err, result) {
        var builder = result.builder;
        var expectedErr = 'Please provide a source image with `from` '
            + 'prior to commit';
        if (!err) {
            t.fail('Expected a build error');
        } else if (String(err).indexOf(expectedErr) === -1) {
            t.fail('Expected `from` command error, got' + err);
        }

        testEnd(t, builder);
    });
});


tape('onbuild', function (t) {
    var fileAndContents = {
        'Dockerfile': [
            'FROM busybox',
            'ONBUILD RUN python-build --dir /app/src'
        ].join('\n')
    };

    testBuildContents(t, fileAndContents, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var img = builder.layers[builder.layers.length - 1].image;
        var expectedOnBuild = [
            'RUN python-build --dir /app/src'
        ];
        t.deepEqual(img.container_config.OnBuild, expectedOnBuild);

        testEnd(t, builder);
    });
});


tape('relativeCopy', function (t) {
    var fileAndContents = {
        'Dockerfile': [
            'FROM busybox',
            'RUN mkdir /test4',
            'WORKDIR /test4',
            'COPY . .'
        ].join('\n'),
        'foo': 'hello',
        'dir1/file1.txt': 'hello'
    };

    testBuildContents(t, fileAndContents, function (err, result) {
        var builder = result.builder;
        if (showError(t, err, builder)) {
            return;
        }

        var expectedFilesystem = {
            'test4': {
                'Dockerfile': fileAndContents['Dockerfile'],
                'foo': fileAndContents['foo'],
                'dir1': {
                    'file1.txt': fileAndContents['dir1/file1.txt']
                }
            }
        };
        verifyFilesystem(t, builder, '/', expectedFilesystem);

        testEnd(t, builder);
    });
});


tape('directoryCopyAlternatives', function (t) {
    var fileAndContents = {
        'Dockerfile': [
            'FROM busybox',
            'RUN mkdir /test1',
            'RUN mkdir /test2',
            'RUN mkdir /test3',
            'RUN mkdir /test4',
            'RUN mkdir -p /deep1/in/depth',
            'RUN mkdir -p /deep2/in/depth',
            'RUN mkdir -p /deep3/in/depth',
            'RUN mkdir -p /deep4/in/depth',
            'COPY . /test1',
            'COPY . /test2/',
            'COPY / /test3',
            'COPY / /test4/',
            'COPY . /deep1/in',
            'COPY . /deep2/in/',
            'COPY / /deep3/in',
            'COPY / /deep4/in/'
        ].join('\n'),
        'foo': 'hello',
        'dir1/file1.txt': 'I am a file'
    };

    testBuildContents(t, fileAndContents, function (err, result) {
        var builder = result.builder;
        if (showError(t, err, builder)) {
            return;
        }

        var d = {
            'Dockerfile': fileAndContents['Dockerfile'],
            'foo': fileAndContents['foo'],
            'dir1': {
                'file1.txt': fileAndContents['dir1/file1.txt']
            }
        };
        var expectedFilesystem = {};
        var i;

        // Deep is like d, but already contains an empty 'depth' directory.
        var deep = utils.objCopy(d);
        deep['depth'] = {};

        for (i = 1; i < 5; i++) {
            expectedFilesystem['test' + i] = d;
            expectedFilesystem['deep' + i] = {
                'in': deep
            };
        }
        verifyFilesystem(t, builder, '/', expectedFilesystem);

        testEnd(t, builder);
    });
});


tape('subDirectoryCopy', function (t) {
    var fileAndContents = {
        'Dockerfile': [
            'FROM busybox',
            'RUN mkdir /dirA',
            'RUN mkdir /dirB',
            'RUN mkdir /dirC',
            'COPY /dir /dirA',
            'COPY /dir/subdirB /dirB',
            'COPY /dir/subdirC /dirC'
        ].join('\n'),
        'dir/fileA.txt': 'This is file A',
        'dir/fileB.txt': 'This is file B',
        'dir/subdirB/subfileB.txt': 'This is subfile B',
        'dir/subdirC/subfileC.txt': 'This is subfile C'
    };

    testBuildContents(t, fileAndContents, function (err, result) {
        var builder = result.builder;
        if (showError(t, err, builder)) {
            return;
        }

        var expectedFilesystem = {
            'dirA': {
                'fileA.txt': fileAndContents['dir/fileA.txt'],
                'fileB.txt': fileAndContents['dir/fileB.txt'],
                'subdirB': {
                    'subfileB.txt': fileAndContents['dir/subdirB/subfileB.txt']
                },
                'subdirC': {
                    'subfileC.txt': fileAndContents['dir/subdirC/subfileC.txt']
                }
            },
            'dirB': {
                'subfileB.txt': fileAndContents['dir/subdirB/subfileB.txt']
            },
            'dirC': {
                'subfileC.txt': fileAndContents['dir/subdirC/subfileC.txt']
            }
        };
        verifyFilesystem(t, builder, '/', expectedFilesystem);

        testEnd(t, builder);
    });
});


// Ensure that adding a lot of small files doesn't error out, or take a long
// time to complete.
tape('addLotsOfFiles', { timeout: 60 * 1000 }, function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar.gz');

    testBuildContext(t, contextFilepath, function (err, result) {
        var builder = result.builder;
        if (showError(t, err, builder)) {
            return;
        }

        // Verify directory contents - the tar file contains 100 directories
        // (1..100), with each dir holding 100 empty files (1..100).
        var NUM_FILES_AND_DIRS = 100;

        var d = {};
        var i;
        for (i = 1; i <= NUM_FILES_AND_DIRS; i++) {
            d[String(i)] = '';
        }

        var expectedFilesystem = {
            'Dockerfile': fs.readFileSync(path.join(builder.contextExtractDir,
                'Dockerfile')).toString()
        };
        for (i = 1; i <= NUM_FILES_AND_DIRS; i++) {
            expectedFilesystem[String(i)] = d;
        }
        verifyFilesystem(t, builder, '/', expectedFilesystem);

        testEnd(t, builder);
    });
});


// Other:
// 1. Test different command formats, i.e. 'RUN foo' and 'RUN ["foo"]'
