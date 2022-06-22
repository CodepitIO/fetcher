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

const PROBLEMS_PATH_UNF = "/problems?page=%s";
const PROBLEM_ID_PATTERN = /\/problems\/(.+)"/i;

const TIMELIMIT_PATTERN = /CPU\s+Time\s+limit:\s+(.+)\s+second/i;
const MEMOLIMIT_PATTERN = /Memory\s+limit:\s+(\d+)\s*([a-zA-Z]{1,2})/i;
const AUTHOR_PATTERN = /Author.+:\s+(.*)\s+/i;
const SOURCE_PATTERN = /Source:\s+(.*)\s+/i;

const client = new RequestClient(Config.url);

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
      let header = $(".problem-sidebar");
      let match;
      if ((match = header.text().match(TIMELIMIT_PATTERN))) {
        data.timelimit = parseFloat(match[1]);
      }
      if ((match = header.text().match(MEMOLIMIT_PATTERN))) {
        data.memorylimit = `${match[1]} ${match[2]}`;
      }
      let src1 = null,
        src2 = null;
      if ((match = header.text().match(AUTHOR_PATTERN))) {
        src1 = _.trim(match[1]);
      }
      if ((match = header.text().match(SOURCE_PATTERN))) {
        src2 = _.trim(match[1]);
      }
      data.source = src1 && src2 ? `${src1} (${src2})` : src1 || src2;
      assert($(".problembody").html().length > 0);
      const content = $(".problembody").html();
      data.html = `
        <script type="text/x-mathjax-config">
          MathJax.Hub.Config({
            tex2jax: {inlineMath: [['$','$']]}
          });
        </script>
        <script
          type="text/javascript"
          async=""
          src="https://cdn.mathjax.org/mathjax/latest/MathJax.js?config=TeX-MML-AM_CHTML"
        ></script>
        ${content}
      `;
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
};

function processProblems(problemsPath, problems, callback) {
  client.get(problemsPath, (err, res, html) => {
    html = html || "";
    let $ = cheerio.load(html);
    let problemMatches = $("table.table2 tbody tr");
    if (problemMatches.length === 0) return callback(new Error());
    problemMatches.each((i, elem) => {
      try {
        const idNameTag = $(elem).find("td:first-child");
        const id = PROBLEM_ID_PATTERN.exec(idNameTag.html())[1];
        const name = idNameTag.find("a").text();
        if (id && name) {
          problems.push({
            id: id,
            name: name,
            oj: TYPE,
          });
        }
      } catch (e) {}
    });
    return callback(null, problems);
  });
}

exports.fetchProblems = (callback) => {
  let problems = [];
  let idx = 0;
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
};
