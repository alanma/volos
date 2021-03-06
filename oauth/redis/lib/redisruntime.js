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

/*
 * This module implements the runtime SPI by storing data in redis.
 *
 * options:
 *   host:    redis host (optional, default = 127.0.0.1)
 *   port:    redis port (optional, default = 6379)
 *   options: redis options (optional, default = {})
 */

/*
 schema:
 volos:oauth:token -> application_id
 volos:oauth:client_id:auth_code -> { redirectUri: redirectUri, scope: scope }
*/

var KEY_PREFIX = 'volos:oauth';
var CRYPTO_BYTES = 256 / 8;
var DEFAULT_TOKEN_LIFETIME = 60 * 60 * 24; // 1 day
var REFRESH_TYPE = 'refresh';
var BEARER_TYPE = 'bearer';
var AUTH_TTL = 60 * 5; // 5 minutes

var querystring = require('querystring');
var crypto = require('crypto');
var redis = require("redis");
var OAuthCommon = require('volos-oauth-common');
var Management = require('volos-management-redis');

var debug;
var debugEnabled;
if (process.env.NODE_DEBUG && /apigee/.test(process.env.NODE_DEBUG)) {
  debug = function(x) {
    console.log('Apigee: ' + x);
  };
  debugEnabled = true;
} else {
  debug = function() { };
}

// clone & extend hash
var _extend = require('util')._extend;
function extend(a, b) {
  var options = _extend({}, a);
  options = _extend(options, b);
  return options;
}

var create = function(config) {
  var mgmt = Management.create(config);
  var spi = new RedisRuntimeSpi(mgmt, config);
  var oauth = new OAuthCommon(spi, config);
  return oauth;
};
module.exports.create = create;

var RedisRuntimeSpi = function(mgmt, config) {
  var host = config.host || '127.0.0.1';
  var port = config.port || 6379;
  var ropts = config.options || {};
  this.client = redis.createClient(port, host, config);
  this.mgmt = mgmt;
};

/*
 * Generate an access token using client_credentials. Parameters:
 *   clientId: required
 *   clientSecret: required
 *   scope: optional
 *   tokenLifetime: lifetime in milliseconds, optional
 *
 * Returns an object with all the fields in the standard OAuth 2.0 response.
 */
RedisRuntimeSpi.prototype.createTokenClientCredentials = function(options, cb) {
  options = extend(options, { type: 'client_credentials' });
  createAndStoreToken(this, options, cb);
};

/*
 * Generate an access token using password credentials. Parameters:
 *   clientId: required
 *   clientSecret: required
 *   scope: optional
 *   tokenLifetime: lifetime in milliseconds, optional
 *   username: required but not checked (must be checked outside this module)
 *   password: required by not checked (must be checked outside this module)
 *
 * Returns an object with all the fields in the standard OAuth 2.0 response.
 */
RedisRuntimeSpi.prototype.createTokenPasswordCredentials = function(options, cb) {
  options = extend(options, { type: 'password', refresh: true });
  createAndStoreToken(this, options, cb);
};

/*
 * Generate an access token for authorization code once a code has been set up. Parameters:
 *   clientId: required
 *   clientSecret: required
 *   code: Authorization code already generated by the "generateAuthorizationCode" method
 *   redirectUri: The same redirect URI that was set in the call to generate the authorization code
 *   tokenLifetime: lifetime in milliseconds, optional
 *
 * Returns an object with all the fields in the standard OAuth 2.0 response.
 */
RedisRuntimeSpi.prototype.createTokenAuthorizationCode = function(options, cb) {
  var self = this;
  consumeAuthCode(self.client, options.clientId, options.code, function(err, hash) {
    if (err) { return cb(err); }
    if (options.redirectUri !== hash.redirectUri) { return cb(invalidRequestError()); }
    options = extend(options, { type: 'authorization_code', refresh: true, scope: hash.scope });
    createAndStoreToken(self, options, cb);
  });
};

/*
 * Generate a redirect response for the authorization_code grant type. Parameters:
 *   clientId: required
 *   redirectUri: required and must match what was deployed along with the app
 *   scope: optional
 *   state: optional but certainly recommended
 *
 * Returns the redirect URI as a string.
 * 4.1.2
 */
RedisRuntimeSpi.prototype.generateAuthorizationCode = function(options, cb) {
  var self = this;
  var redirectUri = options.redirectUri;
  self.mgmt.checkRedirectUri(options.clientId, options.redirectUri, function(err, reply) {
    if (err) { return cb(err); }
    if (!reply) { return cb(invalidRequestError()); }
    createAndStoreAuthCode(self, options.clientId, options.scope, redirectUri, function(err, reply) {
      if (err) { return cb(err); }
      var qs = { code: reply };
      if (options.state) { qs.state = options.state; }
      if (options.scope) { qs.scope = options.scope; }
      var uri = redirectUri + '?' + querystring.stringify(qs);
      return cb(null, uri);
    });
  });
};

/*
 * Generate a redirect response for the implicit grant type. Parameters:
 *   clientId: required
 *   redirectUri: required and must match what was deployed along with the app
 *   scope: optional
 *   state: optional but certainly recommended
 *
 * Returns the redirect URI as a string.
 */
RedisRuntimeSpi.prototype.createTokenImplicitGrant = function(options, cb) {
  var self = this;
  this.mgmt.checkRedirectUri(options.clientId, options.redirectUri, function(err, reply) {
    if (err) { return cb(err); }
    if (!reply) { return cb(invalidRequestError()); }
    options = extend(options, { type: 'authorization_code', refresh: false});
    createAndStoreToken(self, options, function(err, reply) {
      if (err) { return cb(err); }
      var qs = { access_token: reply.access_token, token_type: BEARER_TYPE, expires_in: reply.expires_in };
      if (options.scope) { qs.scope = options.scope; }
      if (options.state) { qs.state = options.state; }
      var uri = options.redirectUri + '#' + querystring.stringify(qs);
      return cb(null, uri);
    });
  });
};

/*
 * Refresh an existing access token, and return a new token. Parameters:
 *   clientId: required
 *   clientSecret: required
 *   refreshToken: required, from the original token grant
 *   scope: optional
 */
RedisRuntimeSpi.prototype.refreshToken = function(options, cb) {
  var self = this;
  console.log('-storeRefreshToken: ' + options.refreshToken);

  self.client.get(_key(options.refreshToken), function(err, reply) {
    if (err) { return cb(err); }
    if (reply) {
      reply = JSON.parse(reply);
      if (reply.token_type === REFRESH_TYPE) {
        createAndStoreToken(self, options, function(err, reply) {
          if (err) { return cb(err); }
          self.client.del(_key(options.refreshToken), redis.print);
          return cb(null, reply);
        });
      }
    } else {
      return cb(invalidRequestError());
    }
  });
};

/*
 * Invalidate an existing token. Parameters:
 *   clientId: required
 *   clientSecret: required
 *   refreshToken: either this or accessToken must be specified
 *   accessToken: same
 */
RedisRuntimeSpi.prototype.invalidateToken = function(options, cb) {
  // check clientId, clientSecret
  this.mgmt.getAppIdForCredentials(options.clientId, options.clientSecret, function(err, reply) {
    if (err) { return cb(err); }
    if (!reply) { return cb(invalidRequestError()); }
  });
  if (options.token) { this.client.del(_key(options.token)); }
  if (options.refreshToken) { this.client.del(_key(options.refreshToken)); }
  return cb(null, 'OK');
};

/*
 * Validate an access token. Specify just the token and we are fine.
 */
RedisRuntimeSpi.prototype.verifyToken = function(token, verb, path, cb) {
  this.client.get(_key(token), function(err, reply) {
    if (err || !reply) {
      return cb(invalidRequestError());
    } else {
      // todo: add developerId
      var result = { appId: reply, developerId: null };
      return cb(null, result);
    }
  });
};

// utility functions

function createAndStoreAuthCode(self, clientId, scope, redirectUri, cb) {
  self.mgmt.getAppForClientId(clientId, function(err, app) {
    if (err) { return cb(err); }

    parseAndValidateScope(scope, app, function(err, scope) {
      if (err) { return cb(err); }

      var code = genSecureToken();
      var hash = JSON.stringify({ redirectUri: redirectUri, scope: scope });
      self.client.set(_key(clientId, code), hash, function(err, reply) {
        if (err) { return cb(err); }
        self.client.expire(_key(code), AUTH_TTL, function(err, reply) {
          return cb(err, code);
        });
      });
    });
  });
}

function consumeAuthCode(client, clientId, code, cb) {
  client.get(_key(clientId, code), function(err, hash) {
    if (err) { return cb(err); }
    if (!hash) { return cb(invalidRequestError()); }
    client.del(_key(code), function(err, reply) {
      return cb(err, JSON.parse(hash));
    });
  });
}

/* options: {
 *   clientId: required
 *   clientSecret: required
 *   scope: optional
 *   tokenLifetime: lifetime in milliseconds, optional
 *   type: required
 *   refresh: optional (default: false)
 *   }
 */
function createAndStoreToken(self, options, cb) {
  self.mgmt.getAppForCredentials(options.clientId, options.clientSecret, function(err, app) {
    if (err) { return cb(err); }
    if (!app) { return cb(invalidRequestError()); }

    parseAndValidateScope(options.scope, app, function(err, scope) {
      if (err) { return cb(err); }

      var ttl = options.tokenLifetime ? (options.tokenLifetime / 1000) : DEFAULT_TOKEN_LIFETIME;
      var token = genSecureToken();
      storeToken(self.client, token, options.type, options.clientId, ttl, scope, function(err, reply) {
        var tokenResponse = reply;
        if (err) { return cb(err); }
        if (options.refresh) {
          var refreshToken = genSecureToken();
          storeRefreshToken(self.client, refreshToken, options.clientId, function(err, reply) {
            if (err) { return cb(err); }
            tokenResponse.refresh_token = refreshToken;
            return cb(null, tokenResponse);
          });
        } else {
          return cb(null, tokenResponse);
        }
      });
    });
  });
}

function parseAndValidateScope(scope, app, cb) {
  if (!scope) { return cb(null, app.defaultScope); }
  var scopes = scope.split(' ');
  // check known scopes (slow, true: but simple, and we shouldn't have to check many)
  for (var i = 0; i < scopes.length; i++) {
    if (app.validScopes.indexOf(scopes[i]) < 0) {
      return cb(new Error('invalid_scope'));
    }
  }
  return cb(null, scope);
}

function invalidRequestError() {
  return new Error('invalid_request');
}

function genSecureToken() {
  return crypto.randomBytes(CRYPTO_BYTES).toString('base64');
}

function storeToken(client, token, type, clientId, ttl, scope, cb) {
  var response = {
    access_token: token,
    token_type: type,
    expires_in: ttl,
  };
  if (scope) { response.scope = scope; }
  client.set(_key(token), JSON.stringify(response), function(err, reply) {
    if (err) { return cb(err); }
    if (ttl) {
      client.expire(_key(token), ttl, function(err, reply) {
        return cb(err, response);
      });
    } else {
      return cb(null, response);
    }
  });
}

function storeRefreshToken(client, token, clientId, cb) {
  console.log('storeRefreshToken: ' + token);
  storeToken(client, token, REFRESH_TYPE, clientId, null, null, cb);
}

function _key() {
  var argsArray = [].slice.apply(arguments);
  argsArray.unshift(KEY_PREFIX);
  return argsArray.join(':');
}