var fs = require('fs');
var path = require('path');

var tape = require('tape');

var shellparser = require('../lib/shellparser');

tape('shell parser', function (t) {

    var allPassed = true;

    // A quieter version of t.equal.
    function equal(val1, val2, message) {
        if (val1 !== val2) {
            allPassed = false;
            t.equal(val1, val2, message);
        }
    }

    var wordsFile = path.join(__dirname, 'files/parser_words.txt');
    fs.readFile(wordsFile, function (err, contents) {
        if (err) {
            t.fail(err);
            t.end();
            return;
        }
        var envs = ["PWD=/home", "SHELL=bash"];
        var lines = String(contents).split('\n');

        lines.forEach(function (line) {
            // Trim comments and blank lines
            var i = line.indexOf('#');
            if (i >= 0) {
                line = line.substr(i);
            }
            line = line.trim();

            if (!line) {
                return;
            }

            var words = line.split('|');
            equal(words.length, 2, 'Check for two words exactly');

            var before = words[0].trim();
            var expected = words[1].trim();
            var newWord;

            try {
                newWord = shellparser.processWord(before, envs);
            } catch (ex) {
                newWord = 'error';
            }

            equal(newWord, expected, 'Check processed value');
        });

        t.equal(allPassed, true, 'Check test success');

        t.end();
    });
});
