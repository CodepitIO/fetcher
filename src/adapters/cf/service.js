"use strict";

const path = require("path"),
  async = require("async"),
  assert = require("assert"),
  cheerio = require("cheerio"),
  _ = require("lodash");

const RequestClient = require("../../../common/lib/requestClient"),
  Util = require("../../../common/lib/utils");

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

const PROBLEMSET_API = "/api/problemset.problems";
const LIMITED_LANG_PATTERN = "following languages are only available languages";
const TIMELIMIT_PATTERN = /([\d.,]+)?\s*seconds?/i;

const client = new RequestClient(Config.url);

exports.import = (problem, callback) => {
  let urlPath = Config.getProblemPath(problem.id);
  client.get(urlPath, (err, res, html) => {
    if (err) return callback(err);
    let data = {};
    try {
      html = html.replace(/(<)([^a-zA-Z\s\/\\!])/g, "&lt;$2");
      if (html.indexOf(LIMITED_LANG_PATTERN) > -1) {
        throw new Error(`Problem ${problem.id} doesn't support any language`);
      }
      data.supportedLangs = Config.getSupportedLangs();
      let $ = cheerio.load(html);
      Util.adjustAnchors($, Config.url + urlPath);
      let content = $("div.problemindexholder");

      let inp = content.find(".input-file");
      inp.find(".property-title").remove();
      if (!_.includes(inp.html(), "standard")) data.inputFile = inp.text();
      let out = content.find(".output-file");
      out.find(".property-title").remove();
      if (!_.includes(out.html(), "standard")) data.outputFile = out.text();

      let match;
      let tl = content.find(".time-limit");
      tl.find(".property-title").remove();
      if ((match = tl.text().match(TIMELIMIT_PATTERN))) {
        data.timelimit = parseFloat(match[1]);
      }

      let ml = content.find(".memory-limit");
      if (ml) {
        ml.find(".property-title").remove();
        ml.text(ml.text().replace(/\s*megabytes?/, " MB"));
        ml.text(ml.text().replace(/\s*kilobytes?/, " KB"));
        ml.text(ml.text().replace(/\s*gigabytes?/, " GB"));
        data.memorylimit = ml.text();
      }

      content.removeAttr("problemindex");
      content.find(".header").remove();
      data.html = `
        <div>
          <script type="text/x-mathjax-config">
            MathJax.Hub.Config({
              tex2jax: {inlineMath: [['$$$','$$$']], displayMath: [['$$$$$$','$$$$$$']]}
            });
          </script>
          <script
            type="text/javascript"
            async
            src="//cdn.mathjax.org/mathjax/latest/MathJax.js?config=TeX-MML-AM_CHTML"
          ></script>
          ${content.html()}
        </div>`;
      assert(data.html.length > 0);
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
};

exports.fetchProblems = (callback) => {
  let problems = [];
  async.waterfall(
    [
      (next) => {
        client.get(PROBLEMSET_API, { json: true }, next);
      },
      (res, data, next) => {
        try {
          data = _.reverse(data.result.problems);
          for (let i = 0; i < data.length; i++) {
            problems.push({
              id: data[i].contestId + data[i].index,
              name: data[i].name,
              oj: TYPE,
            });
          }
          return next(null, problems);
        } catch (err) {
          return next(err);
        }
      },
    ],
    callback
  );
};
