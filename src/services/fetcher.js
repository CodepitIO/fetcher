"use strict";

const CronJob = require("cron").CronJob,
  async = require("async"),
  cheerio = require("cheerio"),
  crypto = require("crypto"),
  mime = require("mime"),
  path = require("path"),
  request = require("request"),
  stream = require("stream"),
  util = require("util"),
  url = require("url"),
  _ = require("lodash");

const Problem = require("../../common/models/problem"),
  Errors = require("../../common/errors"),
  Utils = require("../../common/lib/utils"),
  C = require("../../common/constants"),
  RequestClient = require("../../common/lib/requestClient"),
  S3 = require("./dbs").S3;

const LOAD_AND_IMPORT_INTERVAL = 24 * 60 * 60 * 1000;
const IMPORT_QUEUE_CONCURRENCY = 50;
const IMPORT_QUEUE_PER_OJ_CONCURRENCY = 10;
const S3_QUEUE_CONCURRENCY = 30;

const FETCH_PROBLEMS_CRON = "00 00 03 * * *";
const FETCH_PROBLEMS_TZ = "America/Recife";

module.exports = (() => {
  let allProblems = {};
  let ojs = {};

  let count = 0;

  function importSaveFail(problem, callback) {
    if (!problem.imported) problem.importTries++;
    console.log(`<<< Error! ${problem.id} from ${problem.oj}.`);
    return problem.save(() => {
      return callback && callback(Errors.ImportFailed);
    });
  }

  function uploadImageToS3(data, ext, body, callback) {
    let filename =
      data.problem.id +
      "_" +
      crypto.createHash("sha256").update(data.uri).digest("hex").slice(0, 5) +
      ext;
    let params = {
      Key: path.join("assets/images", data.problem.oj, filename),
      Body: body,
      ACL: "public-read",
      CacheControl: "max-age=31536000",
    };
    return S3.upload(params, callback);
  }

  let uploadImageToS3Queue = async.queue((data, callback) => {
    async.waterfall(
      [
        (next) => {
          return request.head(data.uri, next);
        },
        (res, body, next) => {
          if (!res || !res.headers) {
            return next(new Error(`${data.uri} is not an image`));
          }
          let ext = mime.getExtension(res.headers["content-type"] || "");
          if (!ext) {
            let match = /\.(png|bmp|jpeg|jpg|gif|tiff)$/i.exec(data.uri);
            ext = match && match[1];
          }
          if (!ext || ext === "html" || ext == "txt") {
            return next(new Error(`${data.uri} is not an image`));
          }
          ext = "." + ext;
          if (ext === ".bin") ext = "";
          return request(
            { url: data.uri, encoding: null, rejectUnauthorized: false },
            (err, res, img) => {
              if (err) {
                return next(err);
              }
              uploadImageToS3(data, ext, img, next);
            }
          );
        },
        (details, next) => {
          if (details && details.key) {
            data.elem.attr("src", Utils.getURIFromS3Metadata(details));
          }
          return next();
        },
      ],
      callback
    );
  }, S3_QUEUE_CONCURRENCY);

  let uploadProblemToS3Queue = async.queue((problem, callback) => {
    const OJConfig = Utils.getOJConfig(problem.oj);
    if (problem.isPdf) {
      if (ojs[problem.oj].importPdf) {
        // some ojs may have their own pdf import logic
        return ojs[problem.oj].importPdf(problem, callback);
      }
      let url = OJConfig.url + OJConfig.getProblemPdfPath(problem.id);
      request(
        { url: url, encoding: null, rejectUnauthorized: false },
        (err, res, body) => {
          if (
            err ||
            res.headers["content-length"] < 200 ||
            res.headers["content-type"] !== "application/pdf"
          ) {
            return callback(err || new Error());
          }
          S3.upload(
            {
              Key: `assets/problems/${problem.oj}/${problem.id}.pdf`,
              Body: body,
              ACL: "public-read",
              CacheControl: "max-age=31536000",
            },
            callback
          );
        }
      );
    } else {
      return S3.upload(
        {
          Key: `assets/problems/${problem.oj}/${problem.id}.html`,
          Body: problem.html,
          ACL: "public-read",
          CacheControl: "max-age=1209600",
        },
        callback
      );
    }
  }, S3_QUEUE_CONCURRENCY);

  function fetchImgSrcs(html, problem, callback) {
    const ojConfig = Utils.getOJConfig(problem.oj);
    const uri = ojConfig.url + ojConfig.getProblemPath(problem.id);
    let $ = cheerio.load(html);
    let hasImage = false;
    async.each(
      $("img"),
      (elem, next) => {
        elem = $(elem);
        let link = elem.attr("src");
        if (!link || _.startsWith(link, "formula?")) {
          return next();
        }
        if (link.indexOf("spoj.pl") > -1) {
          link.replace("spoj.pl", "spoj.com");
        }
        hasImage = true;
        uploadImageToS3Queue.push(
          {
            problem: problem,
            uri: url.resolve(uri, link),
            elem: elem,
          },
          next
        );
      },
      () => {
        return callback(null, hasImage, $.html());
      }
    );
  }

  function saveProblems(problems, callback) {
    async.eachSeries(
      problems,
      (data, next) => {
        Problem(data).save(() => {
          return next();
        });
      },
      callback
    );
  }

  function prettyFetchProblems(oj, callback) {
    oj.fetchProblems((err, fetched) => {
      if (!fetched) err = err || new Error();
      if (err) console.log(err);
      else
        console.log("Fetched " + fetched.length + " problems from " + oj.type);
      return callback(err, fetched);
    });
  }

  function runProblemFetchers() {
    console.log("Running daily fetcher...");
    async.waterfall(
      [
        (next) => {
          async.map(
            ojs,
            (oj, cb) => {
              return cb(null, (done) => {
                // Each fetcher has 1 hour to finish
                return async.timeout((callback) => {
                  return prettyFetchProblems(oj, callback);
                }, 60 * 60 * 1000)(done);
              });
            },
            next
          );
        },
        (fns, next) => {
          async.parallel(async.reflectAll(fns), next);
        },
        (problems, next) => {
          problems = _.chain(problems)
            .reduce((result, elem, key) => {
              if (_.isArray(elem.value))
                return _.concat(result, _.values(elem.value));
              else return result;
            }, [])
            .filter((obj) => {
              return !_.has(allProblems, [obj.oj, obj.id]);
            })
            .value();
          saveProblems(problems, next);
        },
        loadProblems,
        importProblemSet,
      ],
      (err, results) => {
        // TODO: log error
      }
    );
  }

  /*
   * The following steps will be executed everyday at 3AM GMT-3.
   * 1. Fetch problem base from all supported OJs.
   * 2. Filter the problems which are currently not listed on allProblems.
   * 3. Add the filtered problems to the database.
   * 4. Reload problems from the database and reset allProblems.
   * 5. Loop through database problems and import those who are not yet
   *    imported.
   */
  function startDailyFetcher(callback) {
    console.log("Setting up daily fetcher...");
    let job = new CronJob({
      cronTime: FETCH_PROBLEMS_CRON,
      onTick: runProblemFetchers,
      timeZone: FETCH_PROBLEMS_TZ,
      runOnInit:
        true &&
        (process.env.NODE_ENV === "development" ||
          process.env.NOVE_ENV === "deployment"),
    });
    job.start();
    return callback && callback();
  }

  function importProblem(problem, callback) {
    let data = {};
    let hasImage = false;
    async.waterfall(
      [
        (next) => {
          return ojs[problem.oj].import(problem, next);
        },
        (_data, next) => {
          data = _data;
          if (!data) return next(new Error("No data returned"));
          if (data.isPdf) return next(null, false, null);
          if (!data.html || data.html.length === 0)
            return next(new Error("Html is empty"));
          // We wait at most 2 minutes to import an image
          return async.timeout((callback) => {
            return fetchImgSrcs(data.html, problem, callback);
          }, 2 * 60 * 1000)(next);
        },
        (_hasImage, html, next) => {
          hasImage = _hasImage;
          data.html = html;
          problem.fullName = null;
          for (var key in data) {
            problem[key] = data[key];
          }
          return uploadProblemToS3Queue.push(problem, next);
        },
      ],
      (err, details) => {
        if (err) {
          if (err !== Errors.NoNeedToImport) {
            return importSaveFail(problem, callback);
          }
          return callback();
        }
        count++;
        problem.importDate = new Date();
        problem.imported = true;
        problem.url = Utils.getURIFromS3Metadata(details);
        console.log(
          `${count}: Imported ${problem.id} from ${problem.oj}. ${problem.url} ${hasImage}`
        );
        problem.html = undefined;
        return problem.save(callback);
      }
    );
  }

  let importProblemToQueue = async.queue((problem, callback) => {
    // 2 minutes to import a problem at most
    return async.timeout((done) => {
      return importProblem(problem, done);
    }, 2 * 60 * 1000)(callback);
  }, IMPORT_QUEUE_CONCURRENCY);

  let ojQueues = {};
  function getPushImportProblemToOJQueue(oj) {
    if (!ojQueues[oj]) {
      ojQueues[oj] = async.queue(
        importProblemToQueue.push,
        Utils.getOJConfig(oj).maxImportWorkers ||
          IMPORT_QUEUE_PER_OJ_CONCURRENCY
      );
    }
    return ojQueues[oj].push;
  }

  function shouldImport(problem) {
    // stop importing problems for unsupported OJs
    if (!ojs[problem.oj]) {
      return false;
    }
    // For each problem not imported, we'll try to import it 10 times
    if (!problem.imported && problem.importTries < 10) {
      return true;
    }
    // Let's not import old problems, as we already did it many times.
    // Problems created more than 3 months ago are considered old.
    let daysSinceCreation = Math.round(
      (new Date() - (problem.createdAt || 0)) / (24 * 60 * 60 * 1000)
    );
    if (daysSinceCreation > 90) {
      return false;
    }
    // Then, we'll retry to import every 7 days, even for already imported problems
    let daysSinceUpdate = Math.round(
      (new Date() - (problem.updatedAt || 0)) / (24 * 60 * 60 * 1000)
    );
    return daysSinceUpdate >= 7;
  }

  function importProblemSet(problems, callback) {
    let importers = _.chain(problems)
      .filter((problem) => {
        return shouldImport(problem);
      })
      .shuffle()
      .map((problem) => {
        return async.retryable(
          3,
          async.apply(getPushImportProblemToOJQueue(problem.oj), problem)
        );
      })
      .value();
    async.parallel(async.reflectAll(importers), () => {
      return callback && callback();
    });
  }

  function loadProblems(callback) {
    Problem.find((err, problems) => {
      allProblems = _.groupBy(problems, "oj");
      _.forEach(allProblems, (value, oj) => {
        allProblems[oj] = _.keyBy(value, "id");
      });
      return callback && callback(null, problems);
    });
  }

  function importOJServices(callback) {
    _.forEach(C.OJS, (oj) => {
      ojs[oj] = require(`../adapters/${oj}/service`);
      ojs[oj].type = oj;
    });
    return callback && callback();
  }

  function loadS3Objects(callback) {
    let CT = undefined;
    let s3Objects = {};
    let totalSize = 0;
    async.forever(
      (next) => {
        S3.listObjectsV2(
          { Prefix: "problems/", ContinuationToken: CT },
          (err, data) => {
            if (err) return next(err);
            _.forEach(data.Contents, (val) => {
              totalSize += val.Size;
              let key = val.Key.match(/problems\/(.*)\.+/i);
              if (key) s3Objects[key[1]] = val.Key;
            });
            console.log(`AWS S3 ${totalSize / 1024 / 1024}MB accumulate`);
            if (!data.NextContinuationToken) return callback && callback();
            CT = data.NextContinuationToken;
            return next();
          }
        );
      },
      () => {
        return callback && callback();
      }
    );
  }

  this.start = (callback) => {
    async.waterfall(
      [importOJServices, loadProblems, importProblemSet, startDailyFetcher],
      callback
    );
  };

  return this;
})();
