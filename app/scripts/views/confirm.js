/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

define(function (require, exports, module) {
  'use strict';

  var AuthErrors = require('lib/auth-errors');
  var BaseView = require('views/base');
  var Cocktail = require('cocktail');
  var Constants = require('lib/constants');
  var ExperimentMixin = require('views/mixins/experiment-mixin');
  var FormView = require('views/form');
  var p = require('lib/promise');
  var ResendMixin = require('views/mixins/resend-mixin');
  var ResumeTokenMixin = require('views/mixins/resume-token-mixin');
  var ServiceMixin = require('views/mixins/service-mixin');
  var Template = require('stache!templates/confirm');

  var t = BaseView.t;

  var View = FormView.extend({
    template: Template,
    className: 'confirm',

    // used by unit tests
    VERIFICATION_POLL_IN_MS: Constants.VERIFICATION_POLL_IN_MS,

    initialize: function () {
      // Account data is passed in from sign up and sign in flows.
      // It's important for Sync flows where account data holds
      // ephemeral properties like unwrapBKey and keyFetchToken
      // that need to be sent to the browser.
      this._account = this.user.initAccount(this.model.get('account'));
    },

    getAccount: function () {
      return this._account;
    },

    context: function () {
      var email = this.getAccount().get('email');

      return {
        email: email,
        isOpenGmailButtonVisible: this._isOpenGmailButtonVisible(),
        safeEmail: encodeURIComponent(email)
      };
    },

    _isOpenGmailButtonVisible: function () {
      var email = this.getAccount().get('email');
      // The "Open Gmail" is only visible in certain contexts
      // we do not show it in mobile contexts because it performs worse on mobile
      return this.broker.hasCapability('openGmailButtonVisible') && email.indexOf('@gmail.com') > 0;
    },

    events: {
      'click #open-gmail': '_gmailTabOpened',
      // validateAndSubmit is used to prevent multiple concurrent submissions.
      'click #resend': BaseView.preventDefaultThen('validateAndSubmit')
    },

    _bouncedEmailSignup: function () {
      this.navigate('signup', {
        bouncedEmail: this.getAccount().get('email')
      });
    },

    _gmailTabOpened: function () {
      this.logViewEvent('openGmail.clicked');
    },

    beforeRender: function () {
      // user cannot confirm if they have not initiated a sign up.
      if (! this.getAccount().get('sessionToken')) {
        this.navigate('signup');
        return false;
      }
    },

    afterRender: function () {
      var graphic = this.$el.find('.graphic');
      graphic.addClass('pulse');

      this.transformLinks();
    },

    afterVisible: function () {
      var self = this;

      // the view is always rendered, but the confirmation poll may be
      // prevented by the broker. An example is Firefox Desktop where the
      // browser is already performing a poll, so a second poll is not needed.

      return self.broker.persistVerificationData(self.getAccount())
        .then(function () {
          return self.invokeBrokerMethod(
                    'beforeSignUpConfirmationPoll', self.getAccount());
        })
        .then(function () {
          return self._startPolling();
        });
    },

    _startPolling: function () {
      var self = this;

      return self._waitForConfirmation()
        .then(function () {
          self.logViewEvent('verification.success');
          self.notifier.trigger('verification.success');
          return self.invokeBrokerMethod(
            'afterSignUpConfirmationPoll', self.getAccount())
            .then(function () {
              // the user is definitely authenticated here.
              if (self.relier.isDirectAccess()) {
                self.navigate('settings', {
                  success: t('Account verified successfully')
                });
              } else {
                self.navigate('signup_complete');
              }
            });
        }, function (err) {
          // The user's email may have bounced because it was invalid.
          // Redirect them to the sign up page with an error notice.
          if (AuthErrors.is(err, 'SIGNUP_EMAIL_BOUNCE')) {
            self._bouncedEmailSignup();
          } else if (AuthErrors.is(err, 'UNEXPECTED_ERROR')) {
            // Hide the error from the user if it is an unexpected error.
            // an error may happen here if the status api is overloaded or if the user is switching networks.
            // Report errors to Sentry, but not the user.
            // Details: github.com/mozilla/fxa-content-server/issues/2638.
            self.sentryMetrics.captureException(err);
            var deferred = p.defer();

            self.setTimeout(function () {
              deferred.resolve(self._startPolling());
            }, self.VERIFICATION_POLL_IN_MS);

            return deferred.promise;
          } else {
            self.displayError(err);
          }
        });
    },

    _waitForConfirmation: function () {
      var self = this;
      var account = self.getAccount();
      return self.fxaClient.recoveryEmailStatus(
          account.get('sessionToken'), account.get('uid'))
        .then(function (result) {
          if (result.verified) {
            account.set('verified', true);
            self.user.setAccount(account);
            return true;
          }

          var deferred = p.defer();

          // _waitForConfirmation will return a promise and the
          // promise chain remains unbroken.
          self.setTimeout(function () {
            deferred.resolve(self._waitForConfirmation());
          }, self.VERIFICATION_POLL_IN_MS);

          return deferred.promise;
        });
    },

    submit: function () {
      var self = this;

      self.logViewEvent('resend');

      return self.getAccount().retrySignUp(
        self.relier,
        {
          resume: self.getStringifiedResumeToken()
        }
      )
      .then(function () {
        self.displaySuccess();
      })
      .fail(function (err) {
        if (AuthErrors.is(err, 'INVALID_TOKEN')) {
          return self.navigate('signup', {
            error: err
          });
        }

        // unexpected error, rethrow for display.
        throw err;
      });
    },

    // The ResendMixin overrides beforeSubmit. Unless set to undefined,
    // Cocktail runs both the original version and the overridden version.
    beforeSubmit: undefined
  });

  Cocktail.mixin(
    View,
    ExperimentMixin,
    ResendMixin,
    ResumeTokenMixin,
    ServiceMixin
  );

  module.exports = View;
});
