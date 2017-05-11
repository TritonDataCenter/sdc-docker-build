#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2016, Joyent, Inc.
#

NAME:=docker

TAPE	:= ./node_modules/.bin/tape

JS_FILES	:= $(shell find lib test -name '*.js')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
CLEAN_FILES += ./node_modules

include ./tools/mk/Makefile.defs


#
# Targets
#
.PHONY: all
all:
	npm install

$(TAPE):
	npm install

# Run *unit* tests.
.PHONY: test
test: $(TAPE)
	@(for F in test/test_*.js; do \
		echo "# $$F" ;\
		$(TAPE) $$F ;\
		[[ $$? == "0" ]] || exit 1; \
	done)

.PHONY: git-hooks
git-hooks:
	[[ -e .git/hooks/pre-commit ]] || ln -s ./tools/pre-commit.sh .git/hooks/pre-commit


include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.targ
