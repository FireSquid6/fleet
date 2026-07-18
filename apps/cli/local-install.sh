#!/usr/bin/env bash

cd $(dirname "$0") || exit

bun run ./build.ts

