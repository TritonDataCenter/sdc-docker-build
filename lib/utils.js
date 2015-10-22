/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var async = require('async');
var once = require('once');


function containsWildcards(name) {
    var i;
    var ch;
    for (i = 0; i < name.length; i++) {
        ch = name[i];
        if (ch === '\\') {
            i++;
        } else if (ch == '*' || ch == '?' || ch == '[') {
            return true;
        }
    }
    return false;
}

function fileCopy(source, target, cb) {
    var cbCalled = false;

    var rd = fs.createReadStream(source);
    rd.on('error', function (err) {
        done(err);
    });
    var wr = fs.createWriteStream(target);
    wr.on('error', function (err) {
        done(err);
    });
    wr.on('close', function (ex) {
        done();
    });
    rd.pipe(wr);

    function done(err) {
        if (cbCalled) {
            return;
        }
        cbCalled = true;

        if (err) {
            cb(err);
            return;
        }

        // Maintain file properties, but not UID or GID.
        async.waterfall([
            function sourceStat(next) {
                fs.stat(source, next);
            },
            function targetChmod(stats, next) {
                fs.chmod(target, stats.mode, function (err2) {
                    next(err2, stats);
                });
            },
            function targetTimestamp(stats, next) {
                fs.utimes(target, stats.atime, stats.mtime, next);
            }
        ], cb);
    }
}

function fileGetSha256(filepath, callback) {
    callback = once(callback);
    // the file you want to get the hash
    var fstream = fs.createReadStream(filepath);
    var hash = crypto.createHash('sha256');
    hash.setEncoding('hex');
    fstream.on('end', function () {
        hash.end();
        if (!callback.called) {
            callback(null, hash.read()); // the desired sha256 sum
        }
    });
    fstream.on('error', function (err) {
        callback(err);
    });

    // read file and pipe it (write it) to the hash object
    fstream.pipe(hash);
}

function fileGetSha256Sync(filepath) {
    // the file you want to get the hash
    var contents = fs.readFileSync(filepath);
    var hash = crypto.createHash('sha256');
    hash.update(contents);
    return hash.digest('hex');
}


/**
 * Copies over all keys in `from` to `to`, or
 * to a new object if `to` is not given.
 */
function objCopy(from, to) {
    if (to === undefined) {
        to = {};
    }
    for (var k in from) {
        to[k] = from[k];
    }
    return to;
}


module.exports = {
    containsWildcards: containsWildcards,
    fileCopy: fileCopy,
    fileGetSha256: fileGetSha256,
    fileGetSha256Sync: fileGetSha256Sync,
    objCopy: objCopy
};
