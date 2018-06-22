'use strict';

const path    = require('path'),
      async   = require('async'),
      assert  = require('assert'),
      util    = require('util'),
      cheerio = require('cheerio'),
      _       = require('lodash');

const Errors        = require('../../../common/errors'),
      RequestClient = require('../../../common/lib/requestClient'),
      Util          = require('../../../common/lib/utils');

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

let ACCESS_KEY = null;
(function fetchAccessKey() {
  require('../../../common/models/oj_account').findOne({type: TYPE}, (err, oj) => {
    ACCESS_KEY = oj.accessKey;
  });
})();

const PROBLEMSET_API_UNF = "/judge/maratonando/%s/problems";

const client = new RequestClient(Config.url);

const TIMELIMIT_PATTERN = /Timelimit:\s+([\d.,]+)/;

exports.import = (problem, callback) => {
  let urlPath = Config.getProblemPath(problem.id);
  client.get(urlPath, (err, res, html) => {
    if (err) return callback(err);
    let data = {};
    try {
      data.supportedLangs = Config.getSupportedLangs();
      html = html.replace(/(<)([^a-zA-Z\s\/\\!])/g, '&lt;$2');
      let $ = cheerio.load(html);
      Util.adjustAnchors($, Config.url + urlPath);
      $('script').remove();
      data.source = $('div.header p').html();
      let tl = $.html().match(TIMELIMIT_PATTERN);
      if (tl) data.timelimit = parseFloat(tl[1]);
      //data.memorylimit = '512 MB';
      $('div.header').remove();
      assert($('body').html().length > 0);
      data.html = '<div class="problem-statement">' + $('body').html(); + '</div>';
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
};

exports.fetchProblems = (callback) => {
  if (!ACCESS_KEY) {
    return callback();
  }
  let problems = [];
  let url = util.format(PROBLEMSET_API_UNF, ACCESS_KEY);
  async.waterfall([
    (next) => {
      client.get(url, {json: true}, next);
    },
    (res, data, next) => {
      try {
        for (let i = 0; i < data.length; i++) {
          if (data[i].ProblemID && data[i].Name) {
            problems.push({
              id: data[i].ProblemID + '',
              name: data[i].Name,
              oj: TYPE
            });
          }
        }
        return next(null, problems);
      } catch (err) {
        return next(err);
      }
    }
  ], callback);
};
