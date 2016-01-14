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

var bunyan = require('bunyan');
var jsprim = require('jsprim');
var libuuid = require('libuuid');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var tape = require('tape');

var dockerbuild = require('../lib/build');

// - Globals

var testContextDir = path.join(__dirname, 'files');
var tarExe = 'tar';
if (process.platform === 'sunos') {
    tarExe = 'gtar';
}

// - Test helpers.

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

    var uuid = libuuid.create();
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
        contextFilepath: fpath,
        workDir: configDir,
        containerRootDir: zoneRoot,
        existingImages: opts.existingImages
    };

    var messages = [];
    var tasks = [];

    var builder = new dockerbuild.Builder(buildOpts);
    builder.chownUid = process.getuid();
    builder.chownGid = process.getgid();

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

        if (t.hasOwnProperty('buildTaskHandler')) {
            result = t.buildTaskHandler(builder, task);

        } else if (task.type === 'image_reprovision') {
            // Return a result for the busybox image task.
            result = [null, {
                'image': {
                    'Config': {
                        'Cmd': [ 'sh' ]
                    },
                    'ContainerConfig': {
                        'Cmd': [ '/bin/sh', '-c', '#(nop) CMD ["sh"]' ]
                    },
                    'Id': 'cfa753dfea5e68a24366dfba16e6edf573'
                                + 'daa447abf65bc11619c1a98a3aff54'
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


function showError(t, err, builder) {
    t.ifErr(err, 'check build successful');
    if (err) {
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
        testEnd(t, builder, err);
        return true;
    }
    return false;
}

function getBuildStepOutput(builder, stepNo) {
    return util.format(' ---> %s\n',
        builder.getShortId(builder.layers[stepNo-1].image.id));
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
            { type: 'stdout', message: 'Step 1 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2 : COPY hello /\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3 : CMD /hello\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },
            { type: 'stdout', message: 'Step 4 : RUN /hello how are you\n' },
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
        var img = builder.layers[3].image;
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
            { type: 'stdout', message: 'Step 1 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2 : LABEL version="1.0"\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3 : MAINTAINER Jérôme Petazzoni'
                                        + ' <jerome@docker.com>\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },
            { type: 'stdout', message: 'Step 4 : ADD rootfs.tar /\n' },
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
            { type: 'stdout', message: 'Step 1 : FROM busybox\n' },
            { type: 'stdout', message: ' ---> cfa753dfea5e\n' },
            { type: 'stdout', message: 'Step 2 : LABEL sdcdocker="true"\n' },
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
            { type: 'stdout', message: 'Step 1 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2 : ADD data /data/\n' },
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
            { type: 'stdout', message: 'Step 1 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2 : COPY . /\n' },
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
            { type: 'stdout', message: 'Step 1 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2 : COPY /foo/bar /other/dir '
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
            { type: 'stdout', message: 'Step 1 : FROM busybox\n' },
            { type: 'stdout', message: ' ---> cfa753dfea5e\n' },

            { type: 'stdout', message: 'Step 2 : ADD test.tar /\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3 : RUN cat /test/foo '
                + '| grep Hi\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: 'Hi\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },

            { type: 'stdout', message: 'Step 4 : ADD test.tar /test.tar\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 4) },
            { type: 'stdout', message: 'Step 5 : RUN cat /test.tar/test/foo '
                + '| grep Hi\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: 'Hi\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 5) },

            { type: 'stdout', message: 'Step 6 : ADD test.tar /unlikely-to-'
                + 'exist\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 6) },
            { type: 'stdout', message: 'Step 7 : RUN cat /unlikely-to-exist/'
                + 'test/foo | grep Hi\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: 'Hi\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 7) },

            { type: 'stdout', message: 'Step 8 : ADD test.tar /unlikely-to-'
                + 'exist-trailing-slash/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 8) },
            { type: 'stdout', message: 'Step 9 : RUN cat /unlikely-to-exist'
                + '-trailing-slash/test/foo | grep Hi\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: 'Hi\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 9) },

            { type: 'stdout', message: 'Step 10 : RUN mkdir /existing-directory'
                + '\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 10) },

            { type: 'stdout', message: 'Step 11 : ADD test.tar /existing-'
                + 'directory\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 11) },
            { type: 'stdout', message: 'Step 12 : RUN cat /existing-directory/'
                + 'test/foo | grep Hi\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: 'Hi\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 12) },

            { type: 'stdout', message: 'Step 13 : ADD test.tar /existing-'
                + 'directory-trailing-slash/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 13) },
            { type: 'stdout', message: 'Step 14 : RUN cat /existing-directory-'
                + 'trailing-slash/test/foo | grep Hi\n' },
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
            { type: 'stdout', message: 'Step 1 : FROM busybox\n' },
            { type: 'stdout', message: ' ---> cfa753dfea5e\n' },

            { type: 'stdout', message: 'Step 2 : ADD test.tar /test.tar\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3 : RUN [[ -d /test.tar ]]\n' },
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
            { type: 'stdout', message: 'Step 1 : FROM busybox\n' },
            { type: 'stdout', message: ' ---> cfa753dfea5e\n' },
            { type: 'stdout', message: 'Step 2 : COPY file*.txt /tmp/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3 : RUN ls /tmp/file1.txt '
                + '/tmp/file2.txt\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },
            { type: 'stdout', message: 'Step 4 : RUN mkdir /tmp1\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 4) },
            { type: 'stdout', message: 'Step 5 : COPY dir* /tmp1/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 5) },
            { type: 'stdout', message: 'Step 6 : RUN ls /tmp1\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 6) },
            { type: 'stdout', message: 'Step 7 : RUN ls /tmp1/dirt '
                + '/tmp1/nested_file /tmp1/nested_dir/nest_nest_file\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 7) },
            { type: 'stdout', message: 'Step 8 : RUN mkdir /tmp2\n' },
            { type: 'stdout', message: util.format(' ---> Running in %s\n',
                                                    builder.getShortId(vmId)) },
            { type: 'stdout', message: getBuildStepOutput(builder, 8) },
            { type: 'stdout', message: 'Step 9 : ADD dir/*dir robots.txt '
                + '/tmp2/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 9) },
            { type: 'stdout', message: 'Step 10 : RUN ls /tmp2/nest_nest_file '
                + '/tmp2/robots.txt\n' },
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


tape('workdir', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        t.equal(builder.image.config.WorkingDir, '/test/subdir');

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
            { type: 'stdout', message: 'Step 1 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2 : WORKDIR /foo/bar\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3 : ADD file.txt .\n' },
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
        builder.layers.forEach(function (layer) {
            var cmd = layer.cmd;
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
                'Config': configWorkdir,
                'ContainerConfig': configWorkdir,
                'Id': '4672e708a636d238f3af151d33c9aeee14d7eabd60b5646'
                    + '04d050ec200917177'
            },
            {
                'Config': configAddFile,
                'ContainerConfig': configAddFile,
                'Id': '6530e406dfec6ea95412afc1495226896eb9c8e0bea695b'
                    + '29102bca1f04ee205'
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
            { type: 'stdout', message: 'Step 1 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2 : WORKDIR /foo/bar\n' },
            { type: 'stdout', message: ' ---> Using cache\n' },
            { type: 'stdout', message: ' ---> 4672e708a636\n' },
            { type: 'stdout', message: 'Step 3 : ADD file.txt .\n' },
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
                'Config': config,
                'ContainerConfig': config,
                'Id': '4672e708a636d238f3af151d33c9aeee14d7eabd60b5646'
                    + '04d050ec200917177'
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
            { type: 'stdout', message: 'Step 1 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 2 : WORKDIR /foo/bar\n' },
            { type: 'stdout', message: ' ---> Using cache\n' },
            { type: 'stdout', message: ' ---> 4672e708a636\n' },
            { type: 'stdout', message: 'Step 3 : ADD file.txt .\n' },
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


// Other:
// 1. Test different command formats, i.e. 'RUN foo' and 'RUN ["foo"]'
