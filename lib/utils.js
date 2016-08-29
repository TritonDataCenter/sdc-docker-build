/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var crypto = require('crypto');
var fs = require('fs');

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

// This escapeRegExp function comes from the Mozilla Javascript Guide:
// https://developer.mozilla.org/docs/Web/JavaScript/Guide/Regular_Expressions
function escapeRegExp(string) {
    /* JSSTYLED */ // this is regex, not code!
    return string.replace(/([.*+?^${}()|\[\]\/\\])/g, '\\$1');
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
    escapeRegExp: escapeRegExp,
    fileGetSha256: fileGetSha256,
    fileGetSha256Sync: fileGetSha256Sync,
    objCopy: objCopy
};
