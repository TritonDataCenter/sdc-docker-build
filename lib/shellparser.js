/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

// This is a port of the docker/docker/builder/shell_parse.go file.

// This will take a single word and an array of env variables and
// process all quotes (" and ') as well as $xxx and ${xxx} env variable
// tokens.  Tries to mimic bash shell process.
// It doesn't support all flavors of ${xx:...} formats but new ones can
// be added by adding code to the "special ${} format processing" section

var util = require('util');


function ShellWord(word, envs, pos) {
    this.word = word;
    this.envs = envs;
    this.pos = pos || 0;
}

// Process the word, starting at 'pos', and stop when we get to the
// end of the word or the 'stopChar' character
ShellWord.prototype.processStopOn = function processStopOn(stopChar) {
    var ch;
    var fn;
    var result = '';
    var charFuncMapping = {
        '\'': this.processSingleQuote,
        '"':  this.processDoubleQuote,
        '$':  this.processDollar
    };

    while (this.pos < this.word.length) {
        ch = this.peek();
        if (ch === stopChar) {
            this.next();
            break;
        }
        fn = charFuncMapping[ch];
        if (fn) {
            // Call special processing function for certain chars
            result += fn.call(this);
        } else {
            // Not special, just add it to the result
            ch = this.next();
            if (ch === '\\') {
                // '\' escapes, except end of line
                ch = this.next();
            }
            result += ch;
        }
    }

    return result;
};

ShellWord.prototype.peek = function peek() {
    if (this.pos === this.word.length) {
        return '';
    }
    return this.word[this.pos];
};

ShellWord.prototype.next = function next() {
    if (this.pos == this.word.length) {
        return '';
    }
    var ch = this.word[this.pos];
    this.pos++;
    return ch;
};

ShellWord.prototype.processSingleQuote = function processSingleQuote() {
    // All chars between single quotes are taken as-is
    // Note, you can't escape '
    var ch;
    var result = '';

    this.next();

    while (1) {
        ch = this.next();
        if (!ch || ch === '\'') {
            break;
        }
        result += ch;
    }
    return result;
};

ShellWord.prototype.processDoubleQuote = function processDoubleQuote() {
    // All chars up to the next " are taken as-is, even ', except any $ chars
    // But you can escape " with a \ (backslash).
    var ch;
    var chNext;
    var result = '';

    this.next();

    while (this.pos < this.word.length) {
        ch = this.peek();
        if (ch === '"') {
            this.next();
            break;
        }
        if (ch === '$') {
            result += this.processDollar();
        } else {
            ch = this.next();
            if (ch === '\\') {
                chNext = this.peek();

                if (!chNext) {
                    // Ignore \ at end of word
                    continue;
                }

                if (chNext === '"' || chNext === '$') {
                    // \" and \$ can be escaped, all other \'s are left as-is
                    ch = this.next();
                }
            }
            result += ch;
        }
    }

    return result;
};

ShellWord.prototype.processDollar = function processDollar() {
    var ch;
    var name;
    var modifier;
    var newValue;
    var word;

    this.next();
    ch = this.peek();
    if (ch === '{') {
        this.next();
        name = this.processName();
        ch = this.peek();
        if (ch === '}') {
            // Normal ${xx} case
            this.next();
            return this.getEnv(name);
        }
        if (ch === ':') {
            // Special ${xx:...} format processing
            // Yes it allows for recursive $'s in the ... spot

            this.next(); // skip over :
            modifier = this.next();

            word = this.processStopOn('}');

            // Grab the current value of the variable in question so we
            // can use to to determine what to do based on the modifier
            newValue = this.getEnv(name);

            switch (modifier) {
                case '+':
                    if (newValue) {
                        newValue = word;
                    }
                    return newValue;
                case '-':
                    if (!newValue) {
                        newValue = word;
                    }
                    return newValue;
                default:
                    throw new Error(util.format(
                        'Unsupported modifier (%c) in substitution: %s',
                        modifier, this.word));
            }
        }
        throw new Error(util.format('Missing ":" in substitution: %s',
            this.word));
    }
    // $xxx case
    name = this.processName();
    if (!name) {
        return '$';
    }
    return this.getEnv(name);
};

ShellWord.prototype.processName = function processName() {
    // Read in a name (alphanumeric or _)
    // If it starts with a numeric then just return $#
    var ch;
    var name = '';

    while (this.pos < this.word.length) {
        ch = this.peek();
        if (!name && '0123456789'.indexOf(ch) >= 0) {
            return this.next();
        }
        if (!(/[a-zA-Z]/.test(ch)) && !(/[0-9]/.test(ch)) && (ch !== '_')) {
            break;
        }
        name += this.next();
    }

    return name;
};

ShellWord.prototype.getEnv = function getEnv(name) {
    var result = '';

    this.envs.some(function getEnvForEach(env) {
        var idx = env.indexOf('=');
        if (idx < 0) {
            if (name === env) {
                // Should probably never get here, but just in case treat
                // it like "var" and "var=" are the same
                result = '';
                return true;
            }
            return false;
        }
        if (name !== env.substr(0, idx)) {
            return false;
        }
        result = env.substr(idx+1);
        return true;
    });

    return result;
};


// ProcessWord will use the 'env' list of environment variables,
// and replace any env var references in 'word'.
function processWord(word, env) {
    var sw = new ShellWord(word, env);
    return sw.processStopOn('');
}


module.exports = {
    processWord: processWord
};
