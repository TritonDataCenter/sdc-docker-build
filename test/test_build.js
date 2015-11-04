var child_process = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var util = require('util');

var bunyan = require('bunyan');
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

    var ringbuffer = new bunyan.RingBuffer({ limit: 10 });
    var log = bunyan.createLogger({
        name: ' ',
        streams: [
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
        containerRootDir: zoneRoot
    };

    var messages = [];
    var tasks = [];

    var builder = new dockerbuild.Builder(buildOpts);

    builder.on('message', function (event) {
        messages.push(event);
    });

    builder.on('task', function (task) {
        var result = [null];

        if (task.type === 'extract_tarfile') {
            handleExtractTarfile(builder, task);
            return;
        }

        if (t.hasOwnProperty('buildTaskHandler')) {
            result = t.buildTaskHandler(builder, task);

        } else if (task.type === 'image_reprovision' && opts.fromBusyboxImage) {
            // Return a result for the busybox image task.
            result = [null, {
                'image': {
                    'config': {
                        'Cmd': [
                            'sh'
                        ]
                    },
                    'docker_id': 'cfa753dfea5e68a24366dfba16e6edf573'
                                + 'daa447abf65bc11619c1a98a3aff54'
                }
            }];
        } else if (task.type === 'run') {
            // Give a result to the run command.
            result = [ null, { exitCode: 0 } ];
        }

        tasks.push(task);
        if (task.callback) {
            task.callback.apply(null, result);
        }
    });

    builder.on('end', function (err) {
        // cleanup
        rimraf(zoneDir, function (rmerr) {
            if (rmerr) {
                log.error('Failed to cleanup directory %s: %s', zoneDir, rmerr);
            }
            var result = {
                builder: builder,
                messages: messages,
                tasks: tasks
            };
            callback(err || rmerr, result);
        });
    });

    builder.start();
}


function handleExtractTarfile(builder, event) {
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

        // Ensure the extraction dir is the full real path.
        builder.contextExtractDir = fs.realpathSync(builder.contextExtractDir,
                                                    builder.realpathCache);

        // XXX: Not sure I can rely on chroot-gtar being on the CN?
        var command = util.format('%s -C %s -xf %s',
            tarExe, extractDir, tarfile);
        log.debug('tar extraction command: ', command);

        child_process.exec(command, function (error, stdout, stderr) {
            if (error) {
                log.error('tar error:', error, ', stderr:', stderr);
            }
            callback(error);
        });
    });
}


function showError(t, err, builder) {
    t.ifErr(err, 'check build successful');
    if (err) {
        var records = builder.log.rbuffer.records;
        if (records.length > 0) {
            console.log('  ---\n');
            console.log('    Last %d log messages:\n', records.length, records);
            console.log('  ...\n');
        }
        t.end();
        return true;
    }
    return false;
}

function getBuildStepOutput(builder, stepNo) {
    return util.format(' ---> %s\n',
        builder.getShortId(builder.layers[stepNo].image.id));
}


// -- actual tests

tape('helloWorldRun', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 0 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 1 : COPY hello /\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 1) },
            { type: 'stdout', message: 'Step 2 : CMD /hello\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3 : RUN /hello\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        var tasks = result.tasks;
        var expectedTasks = {
            cmd: [ '/hello' ],
            env: [],
            type: 'run',
            user: '',
            workdir: '/'
        };
        delete tasks[0]['callback'];
        t.deepEqual(tasks[0], expectedTasks, 'check tasks');

        t.end();
    });
});


tape('busybox', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 0 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 1 : LABEL version="1.0"\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 1) },
            { type: 'stdout', message: 'Step 2 : MAINTAINER Jérôme Petazzoni'
                                        + ' <jerome@docker.com>\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: 'Step 3 : ADD rootfs.tar /\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 3) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        t.end();
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
            { type: 'stdout', message: 'Step 0 : FROM busybox\n' },
            { type: 'stdout', message: ' ---> cfa753dfea5e\n' },
            { type: 'stdout', message: 'Step 1 : LABEL sdcdocker="true"\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 1) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        t.end();
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
            { type: 'stdout', message: 'Step 0 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 1 : ADD data /data/\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 1) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        t.end();
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
            { type: 'stdout', message: 'Step 0 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 1 : COPY . /\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 1) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        t.end();
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

        t.end();
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
            { type: 'stdout', message: 'Step 0 : FROM scratch\n' },
            { type: 'stdout', message: ' --->\n' },
            { type: 'stdout', message: 'Step 1 : WORKDIR /foo/bar\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 1) },
            { type: 'stdout', message: 'Step 2 : ADD file.txt .\n' },
            { type: 'stdout', message: getBuildStepOutput(builder, 2) },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        t.end();
    });
});


tape('forbiddenContextPath', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    testBuildContext(t, contextFilepath, function (err, result) {
        if (!err) {
            t.fail('Expected forbidden path error');
        } else {
            t.ok(String(err).indexOf('Forbidden path outside the build context: ../../') >= 0,
                 'Expect forbidden path exception');
        }
        t.end();
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
        t.deepEqual(builder.config.Env,
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

        t.end();
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
//            { type: 'stdout', message: 'Step 0 : FROM scratch\n' },
//            { type: 'stdout', message: ' --->\n' },
//            { type: 'stdout', message: 'Step 1 : ADD https://raw.github'
//                  + 'usercontent.com/joyent/sdc-docker/master/bin/'
//                  + 'sdc-dockeradm /\n' },
//            { type: 'stdout', message: util.format('Successfully built %s\n',
//                                                    builder.getShortId()) }
//        ];
//        t.deepEqual(messages, expectedMessages, 'check message events');
//
//        t.end();
//    });
// });


// Other:
// 1. Test different command formats, i.e. 'RUN foo' and 'RUN ["foo"]'
