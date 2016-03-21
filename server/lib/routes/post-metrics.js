/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


var activityEvent = require('../activity-event');
var config = require('../configuration');
var MetricsCollector = require('../metrics-collector-stderr');
var StatsDCollector = require('../statsd-collector');
var GACollector = require('../ga-collector');
var logger = require('mozlog')('server.post-metrics');

var DISABLE_CLIENT_METRICS_STDERR = config.get('client_metrics').stderr_collector_disabled;

module.exports = function () {
  var metricsCollector = new MetricsCollector();
  var statsd = new StatsDCollector();
  var ga = new GACollector();
  statsd.init();

  return {
    method: 'post',
    path: '/metrics',
    process: function (req, res) {
      // don't wait around to send a response.
      res.json({ success: true });

      process.nextTick(function () {
        var metrics = req.body || {};

        var contentType = req.get('content-type') || '';
        if (contentType.indexOf('text/plain') === 0) {
          try {
            metrics = JSON.parse(req.body);
          } catch (error) {
            logger.error(error);
            return;
          }
        }

        metrics.agent = req.get('user-agent');

        if (metrics.isSampledUser) {
          if (! DISABLE_CLIENT_METRICS_STDERR) {
            metricsCollector.write(metrics);
          }
          // send the metrics body to the StatsD collector for processing
          statsd.write(metrics);
        }
        ga.write(metrics);

        var events = metrics.events || [];
        var hasFlowBeginEvent = events.some(function (event) {
          return event.type === 'flow.begin';
        });

        if (hasFlowBeginEvent) {
          activityEvent('flow.begin', {
            flow_id: metrics.flowId, //eslint-disable-line camelcase
            flow_time: 0, //eslint-disable-line camelcase
            time: metrics.flowBeginTime
          }, req);
        }
      });
    }
  };
};
