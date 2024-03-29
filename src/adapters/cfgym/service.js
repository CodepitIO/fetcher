"use strict";

const path = require("path"),
  async = require("async"),
  assert = require("assert"),
  cheerio = require("cheerio"),
  _ = require("lodash");

const RequestClient = require("../../../common/lib/requestClient"),
  CFPdfImporter = require("../../services/cf_pdf_importer"),
  Util = require("../../../common/lib/utils");

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

const GYM_CONTESTS_API = "/api/contest.list?gym=true";
const LIMITED_LANG_PATTERN = "following languages are only available languages";
const TIMELIMIT_PATTERN = /([\d.,]+)?\s*seconds?/i;

const client = new RequestClient(Config.url);

function importHtml(problem, callback) {
  let urlPath = Config.getProblemPath(problem.id);
  client.get(urlPath, (err, res, html) => {
    if (err) return callback(err);
    let data = {};
    try {
      html = html.replace(/(<)([^a-zA-Z\s\/\\!])/g, "&lt;$2");
      if (html.indexOf(LIMITED_LANG_PATTERN) > -1) {
        throw new Error(`Problem ${problem.id} doesn't support any language`);
      }
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
          <script type="text/javascript">
            window.MathJax = {
              tex: {
                inlineMath: [['$$$', '$$$']],
                displayMath: [['$$$$$$', '$$$$$$']]
              }
            };
          </script>
          <script type="text/javascript" async src="//cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-mml-chtml.min.js"></script>
          ${content.html()}
        </div>`;
      assert(data.html.length > 0);
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
}

let PdfImportQueue = async.queue((problem, callback) => {
  return new CFPdfImporter().importProblemset(problem, callback);
}, 1);

exports.importPdf = PdfImportQueue.push;

exports.import = (problem, callback) => {
  if (problem.isPdf) {
    return callback(null, problem);
  }
  return importHtml(problem, callback);
};

function getContestProblemsMetadata(contest, callback) {
  let gymPagePath = `/gym/${contest.id}`;
  client.get(gymPagePath, (err, res, html) => {
    if (err) {
      return callback(null, []);
    }
    let problems = [];
    let link;
    let $ = cheerio.load(html);
    $("table.problems tr")
      .nextAll()
      .each((i, elem) => {
        try {
          let id = contest.id + "/" + _.trim($(elem).children().eq(0).text());
          let pcell = $(elem).children().eq(1);
          let _link = pcell.find(`a[href*="/${contest.id}/problem/"]`);
          if (!link) link = _link.attr("href");
          let meta = pcell.find(".notice").remove("div");
          let io = _.trim(meta.find("div").text());
          let tlml = meta
            .html()
            .match(/\s*<div[^<]*<\/div>\s*([.,\d]+)[^\d]*([\d]+)/i);
          let name = _.trim(_link.text());
          let problem = {
            id: id,
            name: name,
            oj: TYPE,
            timelimit: parseFloat(tlml[1]),
            memorylimit: tlml[2] + " MB",
            source: contest.name,
            supportedLangs: Config.getSupportedLangs(),
          };
          if (!io.startsWith("standard")) {
            problem.inputFile = _.trim(_.split(io, "/")[0]);
            problem.outputFile = _.trim(_.split(io, "/")[1]);
          }
          problems.push(problem);
        } catch (e) {}
      });
    if (!link) {
      return callback(null, []);
    }
    client.get(link, (err, res, html) => {
      try {
        if (!res.req.path.match(/\/attachments$/)) {
          return callback(null, problems);
        }
        let $ = cheerio.load(html);
        let td = $('td:contains("English")');
        if (!td) td = $('td:contains("Portuguese")');
        let pdflink = _.trim(td.next().find("a").attr("href"));
        if (!pdflink.endsWith(".pdf")) throw new Error("Not a pdf");
        _.each(problems, (o) => {
          o.isPdf = true;
          o.originalUrl = Config.url + pdflink;
        });
      } catch (e) {
        return callback(null, []);
      }
      return callback(null, problems);
    });
  });
}

exports.fetchProblems = (callback) => {
  let problems = [];
  async.waterfall(
    [
      (next) => {
        client.get(GYM_CONTESTS_API, { json: true }, next);
      },
      (res, data, next) => {
        data = _.filter(data.result, (o) => o.phase === "FINISHED");
        return async.mapLimit(data, 10, getContestProblemsMetadata, next);
      },
    ],
    (err, problems) => {
      return callback(err, _.flatten(problems));
    }
  );
};
