#!/usr/bin/env bash

# fix permissions issues on EFS filesystem mount
chown -R bitbucket:bitbucket /var/atlassian/application-data/bitbucket/shared

/bin/bash $@
