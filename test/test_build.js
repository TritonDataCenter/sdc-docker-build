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

var expectedFailures = {
    'addRemote': 'Error: Not implemented: Add Remote:',
    'helloWorldRun': 'Error: Not implemented: RUN',
    'fromBusyboxLabelEnvRun': 'Error: Not implemented: FROM handling'
};

var tarExe = 'tar';
if (process.platform === 'sunos') {
    tarExe = 'gtar';
}

// - Tests

tape('setup', function (t) {

    var testContextDir = path.join(__dirname, 'files');
    fs.readdirSync(testContextDir).forEach(function (fname) {
        if (fname.slice(-4) === '.tar') {
            // It's a build context - test it.
            if (fname.slice(0, -4) !== 'helloWorldRun') {
                return;
            }
            t.test(fname.slice(0, -4), function (tt) {
                testBuildContext(tt, path.join(testContextDir, fname));
            });
        }
    });
});

function testBuildContext(t, fpath) {
    var log = bunyan.createLogger({ name: ' ' });
    log.level('debug');

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

    var tasks = [];

    var builder = new dockerbuild.Builder(opts);
    monkeyPatchBuilder(builder);

    builder.on('event', function (event) {
    });

    builder.on('task', function (event) {
        tasks.push(task);
        if (event.callback) {
            event.callback();
        }
    });

    builder.on('end', function (err) {
        // cleanup
        rimraf(zoneDir, function (rmerr) {
            if (rmerr) {
                log.error('Failed to cleanup directory %s: %s', zoneDir, rmerr);
            }
            var failMsg = expectedFailures[t.name];
            if (failMsg) {
                t.ok(String(err).indexOf(failMsg) >= 0,
                    'Build failed as expected');
            } else {
                t.ifErr(err, 'check build successful');
            }
            t.ifErr(rmerr, 'build cleanup');
            t.end();
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
