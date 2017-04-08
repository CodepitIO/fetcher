'use strict';

const async   = require('async'),
      assert  = require('assert'),
      path    = require('path'),
      cheerio = require('cheerio'),
      util    = require('util'),
      _       = require('lodash');

const Errors        = require('../../../common/errors'),
      RequestClient = require('../../../common/lib/requestClient'),
      Util          = require('../../../common/lib/utils');

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

const client = new RequestClient(Config.url);

const PROBLEMS_PATH_UNF = "/onlinejudge/showProblems.do?contestId=1&pageNumber=%s";

const TIMELIMIT_PATTERN = /time\s*limit:[^\d]+([\d.,]+)/i;
const MEMOLIMIT_PATTERN = /memory\s*limit:[^\d]+([\d.,]+)/i;

exports.import = (problem, callback) => {
  let urlPath = Config.getProblemPath(problem.id);
  client.get(urlPath, (err, res, html) => {
    if (err) return callback(err);
    let data = {};
    try {
      data.supportedLangs = Config.getSupportedLangs();
      html = html.replace(/(<)([^a-zA-Z\s\/\\!])/g, '&lt;$2');
      data.timelimit = parseFloat(html.match(TIMELIMIT_PATTERN)[1])
      data.memorylimit = Math.round(parseFloat(html.match(
        MEMOLIMIT_PATTERN)[1]) / 1024.) + ' MB';
      let $ = cheerio.load(html);
      Util.adjustAnchors($, Config.url + urlPath);
      let body = $('#content_body');
      $('b').replaceWith(function () {
        if (/(input|output|hint|task|introduction)/i.exec($(this).text()) &&
              $(this).text().length < 25) {
          return "<div class='section-title'>" + $(this).html() + "</div>";
        }
        return $(this).html();
      });
      let sid = $('a[href*="/onlinejudge/submit.do?problemId="]')
        .attr('href').match(/=(\d+)$/)[1];
      body.children().slice(0,4).remove();
      html = body.html();
      let author = /\s*Author[^<]*<strong>([^<]*)<\/strong>/.exec(html);
      author = author && author[1];
      let source = /\s*Source[^<]*<strong>([^<]*)<\/strong>/.exec(html);
      source = source && source[1];
      html = html.replace(/\s+<hr>[\s\S]*?$/, '');
      assert(html.length > 0);
      html =
        '<div class="zoj-problem problem-statement ttypography">' +
          html +
        '</div>' +
        '<script>' +
          '$(function() { MathJax.Hub.Typeset("zoj"); });' +
        '</script>';
      if (author || source) {
        data.source = 'Source: ' +
          ((author && source && `${source} (${author})`) || author || source);
      }
      data.sid = sid;
      data.html = html;
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
}

function processProblems(problemsPath, problems, callback) {
  client.get(problemsPath, (err, res, html) => {
    html = html || '';
    let $ = cheerio.load(html);
    let problemsList = $('table.list').find('tr');
    if (problemsList.length <= 1) {
      return callback(new Error("No problems to parse"));
    }
    let error = null;
    let problemMatches = problemsList.each((i, item) => {
      if (i == 0) return;
      try {
        let id = $(item).find('.problemId').text();
        if (problems.length > 0 && parseInt(_.last(problems).id) > parseInt(id)) {
          throw new Error("No problems to parse");
        }
        let name = $(item).find('.problemTitle').text();
        if (id && name) {
          problems.push({
            id: id,
            name: name,
            oj: TYPE
          });
        }
      } catch (e) {
        error = e;
      }
    });
    return callback(error, problems);
  });
}

exports.fetchProblems = (callback) => {
  let problems = [];
  let idx = 1;
  async.forever(
    (next) => {
      let problemsPath = util.format(PROBLEMS_PATH_UNF, idx);
      idx = idx + 1;
      return processProblems(problemsPath, problems, next);
    },
    (err) => {
      return callback(null, problems);
    }
  );
}
