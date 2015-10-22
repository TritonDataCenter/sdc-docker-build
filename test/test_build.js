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

// - Tests

function testBuildContext(t, fpath, callback) {
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

    var opts = {
        log: log,
        uuid: uuid,
        contextFilepath: fpath,
        workDir: configDir,
        containerRootDir: zoneRoot
    };

    var messages = [];
    var tasks = [];

    var builder = new dockerbuild.Builder(opts);
    monkeyPatchBuilder(builder);

    builder.on('message', function (event) {
        messages.push(event);
    });

    builder.on('task', function (task) {
        var result = [null];
        if (t.hasOwnProperty('buildTaskHandler')) {
            result = t.buildTaskHandler(builder, task);
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


function monkeyPatchBuilder(builder) {

    // Remove chroot-gtar command.
    builder.extractContext = function (callback) {
        var log = builder.log;
        log.debug('Extracting docker context to:', builder.contextExtractDir);

        mkdirp(builder.contextExtractDir, function (err) {
            if (err) {
                callback(err);
                return;
            }

            // XXX: Not sure I can rely on chroot-gtar being on the CN?
            var command = util.format(tarExe + ' -C %s -xf %s',
                builder.contextExtractDir, builder.contextFilepath);
            log.debug('tar extraction command: ', command);

            child_process.exec(command, function (error, stdout, stderr) {
                if (error) {
                    log.error('tar error:', error, ', stderr:', stderr);
                }
                callback(error);
            });
        });
    };

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


tape('helloWorldRun', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    // Give a result to the run command.
    t.buildTaskHandler = function (builder, event) {
        if (event.type === 'run') {
            return [ null, { exitCode: 0 } ];
        }
    };

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
            { type: 'stdout', message: 'Step 2 : CMD /hello\n' },
            { type: 'stdout', message: 'Step 3 : RUN /hello\n' },
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
            { type: 'stdout', message: 'Step 1 : LABEL [object Object]\n' },
            { type: 'stdout', message: 'Step 2 : MAINTAINER Jérôme Petazzoni'
                                        + ' <jerome@docker.com>\n' },
            { type: 'stdout', message: 'Step 3 : ADD rootfs.tar /\n' },
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

        t.end();
    });
});


tape('fromBusyboxLabel', function (t) {
    var contextFilepath = path.join(testContextDir, t.name + '.tar');

    // Return a result for the busybox image task.
    t.buildTaskHandler = function (builder, event) {
        if (event.type === 'image_reprovision') {
            var result = {
                'image': {
                    'config': {
                        'Cmd': [
                            'sh'
                        ],
                        'Image': 'cfa753dfea5e68a24366dfba16e6edf573'
                                + 'daa447abf65bc11619c1a98a3aff54'
                    }
                }
            };
            return [ null, result ];
        }
    };

    testBuildContext(t, contextFilepath, function (err, result) {
        if (showError(t, err, result.builder)) {
            return;
        }

        var builder = result.builder;
        var messages = result.messages;
        var expectedMessages = [
            { type: 'stdout', message: 'Step 0 : FROM busybox\n' },
            { type: 'stdout', message: ' ---> cfa753dfea5e\n' },
            { type: 'stdout', message: 'Step 1 : LABEL [object Object]\n' },
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
            { type: 'stdout', message: util.format('Successfully built %s\n',
                                                    builder.getShortId()) }
        ];
        t.deepEqual(messages, expectedMessages, 'check message events');

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
