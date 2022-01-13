"use strict";

const path = require("path"),
  async = require("async"),
  assert = require("assert"),
  util = require("util"),
  cheerio = require("cheerio"),
  _ = require("lodash");

const Errors = require("../../../common/errors"),
  RequestClient = require("../../../common/lib/requestClient"),
  Util = require("../../../common/lib/utils");

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

const PROBLEMSET_PATH = "/judge/en/problems/all?page=%s";

const client = new RequestClient(Config.url);

const TIMELIMIT_PATTERN = /Timelimit:\s+([\d.,]+)/;

exports.import = (problem, callback) => {
  let urlPath = Config.getProblemPath(problem.id);
  client.get(urlPath, (err, res, html) => {
    if (err) return callback(err);
    let data = {};
    try {
      data.supportedLangs = Config.getSupportedLangs();
      html = html.replace(/(<)([^a-zA-Z\s\/\\!])/g, "&lt;$2");
      let $ = cheerio.load(html);
      Util.adjustAnchors($, Config.url + urlPath);
      $("script").remove();
      data.source = $("div.header p").html();
      let tl = $.html().match(TIMELIMIT_PATTERN);
      if (tl) data.timelimit = parseFloat(tl[1]);
      //data.memorylimit = '512 MB';
      $("div.header").remove();
      assert($("body").html().length > 0);
      data.html = '<div class="problem-statement">' + $("body").html();
      +"</div>";
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
};

exports.fetchProblems = (callback) => {
  let problems = [];
  let html = "";
  function iterateProblemsPage(pageIdx) {
    let urlPath = util.format(PROBLEMSET_PATH, pageIdx);
    client.get(urlPath, (err, res, _html) => {
      html = _html;
      let $ = cheerio.load(html);
      $("#element tbody tr").each((i, elem) => {
        let id = _.trim($(elem).find(".id a").text());
        let name = _.trim($(elem).find(".id").nextAll().eq(1).text());
        problems.push({
          id: id,
          name: name,
          oj: TYPE,
        });
      });
      let isLastPage = $("li.next").hasClass("disabled");
      if (isLastPage) {
        return callback(null, problems);
      }
      return iterateProblemsPage(pageIdx + 1);
    });
  }
  iterateProblemsPage(1);
};
