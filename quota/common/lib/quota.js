/****************************************************************************
 The MIT License (MIT)

 Copyright (c) 2013 Apigee Corporation

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 ****************************************************************************/
"use strict";

var util = require('util');

function checkNumber(val, name) {
  if (!val) {
    return undefined;
  }
  if (typeof val === 'string') {
    return parseInt(val, 10);
  } else if (typeof val === 'number') {
    return val;
  } else {
    throw new Error(util.format('%s must be a number', name));
  }
}

var TimeUnits = [ 'hour', 'minute', 'day', 'week' ];

var MINUTE = 6000;
var HOUR = MINUTE * 60;
var DAY = HOUR * 24;
var WEEK = DAY * 7;

// options.startTime (Date, Number, or String date) default = now
//    If set, quota starts at the start time, modulated by what time it is now
// options.rollingWindow (boolean) default = false
//    If set, then quota is rolled over the last period, not reset periodically
// options.timeUnit ("hours", "minutes", or "days") default = minutes
// options.interval (Number) default = 1
// options.allow (Number) default = 1
// options.consistency (string) A hint to some SPIs about how to distribute quota around

function Quota(Spi, o) {
  var options = o || {};
  options.timeUnit = o.timeUnit || 'minutes';
  options.interval = checkNumber(o.interval, 'interval') || 1;
  options.allow = checkNumber(o.allow, 'allow') || 1;
  options.rollingWindow = o.rollingWindow || false;

  if (!options.timeUnit in TimeUnits) {
    throw new Error(util.format('Invalid timeUnit %s', options.timeUnit));
  }

  if ('minute' === options.timeUnit) {
    options.timeInterval = MINUTE;
  } else if ('hour' === options.timeUnit) {
    options.timeInterval = HOUR;
  } else if ('day' === options.timeUnit) {
    options.timeInterval = DAY;
  } else if ('week' === options.timeUnit) {
    options.timeInterval = WEEK;
  }

  if (options.startTime) {
    if (typeof options.startTime === 'string') {
      var sd = new Date(options.startTime);
      options.startTime = sd.getTime();
    } else if (options.startTime instanceof Date) {
      options.startTime = options.startTime.getTime();
    } else if (typeof options.startTime !== 'number') {
      throw new Error(util.format('Invalid start time %s', options.startTime));
    }
  }

  this.options = options;
  this.quota = new Spi(options);
}
module.exports = Quota;

// options.identifier (Non-object) required
// options.weight (Number) default = 1
// options.allow (Number) default = whatever was set in policy setup, and this allows override
// cb is invoked with first parameter error, second whether it was allowed, third stats on the quota
// stats.allowed = setting of "allow"
// stats.used = current value

Quota.prototype.apply = function(o, cb) {
  var options = o || {};
  options.weight = checkNumber(o.weight, 'weight') || 1;
  options.allow = checkNumber(o.allow, 'allow') || this.options.allow;

  if (!options.identifier) {
    throw new Error('identifier must be set');
  }
  if (typeof options.identifier !== 'string') {
    throw new Error('identifier must be a string');
  }

  this.quota.apply(options, function(err, result) {
    cb(err, result);
  });
};
