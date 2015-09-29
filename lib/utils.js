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
        if (!cbCalled) {
            cb(err);
            cbCalled = true;
        }
    }
}

function fileGetSha256(filepath, callback) {
    callback = once(callback);
    // the file you want to get the hash
    var fstream = fs.createReadStream(filepath);
    var hash = crypto.createHash('sha1');
    hash.setEncoding('hex');
    fstream.on('end', function () {
        hash.end();
        if (!callback.called) {
            callback(null, hash.read()); // the desired sha1sum
        }
    });
    fstream.on('error', function (err) {
        callback(err);
    });

    // read file and pipe it (write it) to the hash object
    fstream.pipe(hash);
}


module.exports = {
    containsWildcards: containsWildcards,
    fileCopy: fileCopy,
    fileGetSha256: fileGetSha256
};
