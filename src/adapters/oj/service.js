'use strict';

const cheerio = require('cheerio'),
      assert  = require('assert'),
      async   = require('async'),
      path    = require('path'),
      util    = require('util'),
      iconv   = require('iconv-lite'),
      _       = require('lodash');

const Errors        = require('../../../common/errors'),
      RequestClient = require('../../../common/lib/requestClient'),
      Util          = require('../../../common/lib/utils');

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

const VOLUMES = ["/index.php?option=com_onlinejudge&Itemid=8&category=1",
                 "/index.php?option=com_onlinejudge&Itemid=8&category=2"];
const PROBLEM_PATTERN = /^(\d+)\s*-\s*(.*)/i;
const client = new RequestClient(Config.url);

const PROBLEM_METADATA_API = "https://uhunt.onlinejudge.org/api/p/num/%s";

function getContent(urlPath, data, html, id) {
  if (!_.includes(html, '<body>')) {
    html = `<body>${html}</body>`;
  }
  html = html.replace(/(<)([^a-zA-Z\s\/\\!])/g, '&lt;$2');
  let $ = cheerio.load(html);
  let body = $('body');
  let vol = parseInt(id / 100);
  Util.adjustAnchors($, Config.url + urlPath);
  body.find('table[bgcolor="#0060F0"]').first().remove();
  body.find('h1').first().remove();
  body.find('h2').each((i, item) => {
    $(item).html($(item).text());
  });
  let adr = body.find('address');
  if (adr) {
    adr.children().each((i, item) => {
      let text = _.trim($(item).text());
      if (text.length > 0) {
        if (data.source) data.source += ' ' + text;
        else data.source = text;
      }
    });
    adr.prev().remove();
    adr.remove();
  }
  assert(body.html().length > 0);
  data.html = '<div class="problem-statement">' + body.html() + '</div>';
}

exports.import = (problem, callback) => {
  let metadataUrl = util.format(PROBLEM_METADATA_API, problem.id);
  let problemUrl = Config.getProblemPath(problem.id);
  async.parallel({
    meta: (next) => {
      return client.get(metadataUrl, {json: true}, next);
    },
    body: (next) => {
      return client.get(problemUrl, {encoding: null}, next);
    }
  }, (err, results) => {
    if (err) return callback(err);
    let data = {};
    try {
      data.supportedLangs = Config.getSupportedLangs();
      let tl = results.meta[1] && results.meta[1].rtl || 3000;
      data.timelimit = tl / 1000.0;
      let html = iconv.decode(results.body[1], 'ISO-8859-1');
      data.isPdf = (_.includes(html, "HTTP-EQUIV") && html.length <= 200);
      if (!data.isPdf) getContent(problemUrl, data, html, problem.id);
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
};

function reduceProblems(problems, href, callback) {
  client.get(href, (err, res, html) => {
    html = html || '';
    let $ = cheerio.load(html);
    $('tr.sectiontableheader').nextAll().each((i, elem) => {
      elem = $(elem).children().eq(2).text();
      let res = PROBLEM_PATTERN.exec(elem);
      if (res && res[1] && res[2]) {
        problems.push({
          id: res[1],
          name: res[2],
          oj: TYPE
        });
      }
    });
    return callback(null, problems);
  });
}

function reduceVolumes(problems, volumePath, callback) {
  async.waterfall([
    (next) => {
      client.get(volumePath, next);
    },
    (res, html, next) => {
      html = html || '';
      let $ = cheerio.load(html);
      let volumesHref = [];
      $('a:contains("Volume ")').each((i, elem) => {
        volumesHref.push('/' + $(elem).attr('href'));
      });
      async.reduce(volumesHref, problems, reduceProblems, next);
    }
  ], callback);
}

exports.fetchProblems = (callback) => {
  async.reduce(VOLUMES, [], reduceVolumes, callback);
};
