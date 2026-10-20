#!/usr/bin/env node
/** 生成一个可直接粘贴进 .env 的 SESSION_SECRET */
const crypto = require('crypto');
console.log('SESSION_SECRET=' + crypto.randomBytes(48).toString('base64url'));

