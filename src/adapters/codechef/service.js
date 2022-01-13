"use strict";

const cheerio = require("cheerio"),
  assert = require("assert"),
  async = require("async"),
  path = require("path"),
  util = require("util"),
  _ = require("lodash");

const RequestClient = require("../../../common/lib/requestClient"),
  Util = require("../../../common/lib/utils");

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

const VOLUMES = [
  "/problems/school/",
  "/problems/easy/",
  "/problems/medium/",
  "/problems/hard/",
  "/problems/extcontest/",
];

const PROBLEMS_PATH_UNF = "/api/contests/PRACTICE/problems/%s";

const client = new RequestClient(Config.url);

exports.import = (problem, callback) => {
  let urlPath = util.format(PROBLEMS_PATH_UNF, problem.id);
  client.get(urlPath, { json: true }, (err, res, meta) => {
    if (err) return callback(err);
    let data = {};
    try {
      if (meta.status !== "success") {
        throw new Error("Problem could not be fetched.");
      }
      let supportedLangs = Config.getSupportedLangs(meta.languages_supported);
      if (supportedLangs.length === 0) {
        throw new Error(`Problem ${problem.id} doesn't support any language`);
      }
      data.supportedLangs = supportedLangs;
      let html = meta.body.replace(/(<)([^a-zA-Z\s\/\\!])/g, "&lt;$2");
      let $ = cheerio.load(html);
      Util.adjustAnchors($, Config.url + urlPath);
      $(".solution-visible-txt").remove();
      while (true) {
        let firstElem = $("*").first();
        if (!firstElem.is("h3")) {
          break;
        }
        firstElem.remove();
      }
      let trimmedHtml = _.trim($.html(), "\n");
      assert(trimmedHtml.length > 0);
      data.html =
        '<div id="codechef" class="problem-statement ttypography">' +
        trimmedHtml +
        "</div>";
      if (meta.problem_author) {
        data.source = `Author: ${meta.problem_author}`;
      }
      if (/[^0-9.,]*([0-9.,]+)/.exec(meta.max_timelimit)) {
        meta.max_timelimit = /[^0-9.,]*([0-9.,]+)/.exec(meta.max_timelimit)[1];
        data.timelimit = parseFloat(meta.max_timelimit);
      }
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
};

function reduceProblems(problems, href, callback) {
  client.get(href, (err, res, html) => {
    html = html || "";
    let $ = cheerio.load(html);
    let elem = $("tr.problemrow").first().next();
    let i = 0;
    while (true) {
      let name = _.trim($(elem).find(".problemname").text());
      if (!name) break;
      let id = _.replace(
        $(elem).find(".problemname a").attr("href"),
        "/problems/",
        ""
      );
      if (name && id) {
        problems.push({
          id: id,
          name: name,
          oj: TYPE,
        });
      }
      elem = elem.next();
    }
    return callback(null, problems);
  });
}

exports.fetchProblems = (callback) => {
  async.reduce(VOLUMES, [], reduceProblems, callback);
};
