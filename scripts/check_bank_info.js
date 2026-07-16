'use strict';
const fs = require('fs');

const data = JSON.parse(fs.readFileSync('f:/LamDH/Project/369futures/data/step_sizes.json', 'utf8'));
console.log('BANK info:', data.h4Cache['BANK']);
console.log('BANK tickSize:', data.tickSizes['BANKUSDT']);
console.log('BANK stepSize:', data.stepSizes['BANKUSDT']);
