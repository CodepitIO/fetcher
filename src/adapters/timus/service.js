'use strict';

const cheerio = require('cheerio'),
      assert  = require('assert'),
      async   = require('async'),
      path    = require('path'),
      util    = require('util');

const Errors        = require('../../../common/errors'),
      RequestClient = require('../../../common/lib/requestClient'),
      Util          = require('../../../common/lib/utils');

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

const PROBLEMS_PATH = "/problemset.aspx?space=1&page=all";

const client = new RequestClient(Config.url);

const TIMELIMIT_PATTERN = /time\s*limit:\s*([\d.,]+)\s*\w/i;
const MEMOLIMIT_PATTERN = /memory\s*limit:\s*([\d\w\s]+)/i;

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
      let header = $('.problem_limits');
      let match;
      if (match = header.html().match(TIMELIMIT_PATTERN)) {
        data.timelimit = parseFloat(match[1]);
      }
      if (match = header.html().match(MEMOLIMIT_PATTERN)) {
        data.memorylimit = match[1];
      }
      let source = $('.problem_source');
      source.find('b').remove();
      if (source && source.text()) data.source = source.text();
      source.remove();
      assert($('#problem_text').html().length > 0);
      data.html = '<div class="timus-problem">' + $('#problem_text').html() + '</div>';
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
}

exports.fetchProblems = (callback) => {
  client.get(PROBLEMS_PATH, (err, res, html) => {
    html = html || '';
    let problems = [];
    let $ = cheerio.load(html);
    $('tr.content').nextAll().each((i, elem) => {
      elem = $(elem).children();
      let id = elem.eq(1).html();
      let name = elem.eq(2).text();
      if (id && name) {
        problems.push({
          id: id,
          name: name,
          oj: TYPE
        });
      }
    });
    return callback(null, problems);
  });
}
