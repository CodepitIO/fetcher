'use strict';

const path      = require('path'),
      async     = require('async'),
      assert    = require('assert'),
      cheerio   = require('cheerio'),
      util      = require('util'),
      fs        = require('fs'),
      _         = require('lodash')

const Errors        = require('../../../common/errors'),
      RequestClient = require('../../../common/lib/requestClient'),
      Util          = require('../../../common/lib/utils');

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

const VOLUMES = ["contest_noturno", "mineira", "obi", "regionais",
                 "seletivas", "seletiva_ioi", "sulamericana"];
const PROBLEMS_PATH_UNF = "/problems/%s/start=%s";

const maxPerPage = 50;

const LAST_PAGE_PATTERN = /start=(\d+)/;
const PROBLEM_ID_PATTERN = /^\/problems\/(.+)/;
const METADATA_PATTERN = /^(?:.+)?:\s*(.+)/i;
const TIMELIMIT_PATTERN = /([\d.,]+)/;
const MEMOLIMIT_PATTERN = /([\d.,]+)\s*(\w+)/;

const tmplPath = './src/adapters/spojbr/problem_template.html';
const tmpl = _.template(fs.readFileSync(tmplPath, 'utf8'));

const client = new RequestClient(Config.url);

function getMetadata(elem) {
  try {
    return elem.text().match(METADATA_PATTERN)[1];
  } catch (err) {
    return null;
  }
}

exports.import = (problem, callback) => {
  let urlPath = Config.getProblemPath(problem.id);
  client.get(urlPath, (err, res, html) => {
    if (err) return callback(err);
    let data = {};
    try {
      html = html.replace(/(<)([^a-zA-Z\s\/\\!])/g, '&lt;$2');
      let $ = cheerio.load(html);
      let langs = $('.probleminfo td:contains("Linguagem")').next().text();
      let supportedLangs = Config.getSupportedLangs(langs);
      if (supportedLangs.length === 0) {
        throw new Error(`Problem ${problem.id} doesn't support any language`);
      }
      data.supportedLangs = supportedLangs;
      $('h3').replaceWith(function () {
        return "<div class='section-title'>" + $(this).html() + "</div>";
      });
      Util.adjustAnchors($, Config.url + urlPath);
      let header = $('.probleminfo').children(), match;
      let tl = getMetadata(header.eq(2));
      if (tl && (match = tl.match(TIMELIMIT_PATTERN))) {
        data.timelimit = parseFloat(match[1]);
      }
      let ml = getMetadata(header.eq(4));
      if (ml && (match = ml.match(MEMOLIMIT_PATTERN))) {
        data.memorylimit = `${match[1]} ${match[2]}`;
      }
      let rs = getMetadata(header.eq(7));
      if (rs) {
        data.source = rs;
      }
      let description = $('.prob');
      description.find('pre').each((i, item) => {
        item = $(item);
        let data = item.html();
        data = data.replace(/\r/g, '');
        data = data.replace(/\n/g, '<br>');
        data = data.replace(/^(?:<br>)*/g, '');
        data = data.replace(/(?:<br>)*$/g, '');
        data = data.replace(/<strong>\s*<br>/, '<strong>');
        item.html(data);
      });
      assert(description.html().length > 0);
      data.html = tmpl({description: description.html()})
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
}

function reduceProblems(problems, href, callback) {
  client.get(href, (err, res, html) => {
    html = html || '';
    let $ = cheerio.load(html);
    $('tr.problemrow').each((i, elem) => {
      elem = $(elem).children().eq(1).find('a');
      let id = elem.attr('href').match(PROBLEM_ID_PATTERN)[1];
      let name = elem.find('b').text();
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

function reduceVolumes(problems, volume, callback) {
  async.waterfall([
    (next) => {
      let url = util.format(PROBLEMS_PATH_UNF, volume, 0);
      client.get(url, next);
    },
    (res, html, next) => {
      html = html || '';
      let problemsHref = [];
      let lastPage = 0;
      try {
        let $ = cheerio.load(html);
        let elem = $('a.pager_link:contains(">")').attr('href');
        lastPage = parseInt(elem.match(LAST_PAGE_PATTERN)[1]);
      } catch (err) {}
      let idx = 0;
      while (idx <= lastPage) {
        let url = util.format(PROBLEMS_PATH_UNF, volume, idx);
        problemsHref.push(url);
        idx += maxPerPage;
      }
      return async.reduce(problemsHref, problems, reduceProblems, next);
    }
  ], callback);
}

exports.fetchProblems = (callback) => {
  async.reduce(VOLUMES, [], reduceVolumes, callback);
}
