const request = require('request');
const fs = require('fs-extra');
const path = require('path');
const async = require('async');
const exec = require('child_process').exec;
const execSync = require('child_process').execSync;
const Problem = require('../../../common/models/problem');
const _ = require('lodash');
const S3 = require('../../services/dbs').S3;
const Errors = require('../../../common/errors');
const Utils = require('../../../common/lib/utils');

let triedUrls = {};

module.exports = function() {
  let allMetadata, hasFooter;

  function getPDFTextWithHeight(file, k) {
    try {
      let out = execSync(`pdftotext ${file} -x 0 -y 0 -W 2000 -H ${k} -`);
      return out.toString('utf8');
    } catch (e) {}
    return null;
  }

  function getUpperOffset(file) {
    try {
      let i = 0, j = 256;
      while (i < j) {
        let k = Math.ceil((i + j) / 2);
        let metadata = hasMetadata(getPDFTextWithHeight(file, k));
        if (metadata && metadata.includes('name')) {
          j = k - 1;
        } else {
          i = k;
        }
      }
      let length = getPDFTextWithHeight(file, i).length;
      i = 0;
      while (i < j) {
        let k = Math.ceil((i + j) / 2);
        let out = execSync(`pdftotext ${file} -x 0 -y 0 -W 2000 -H ${k} -`).toString('utf8');
        if (out.length === length) {
          j = k - 1;
        } else {
          i = k;
        }
      }
      return Math.ceil((i+1) * 1.25);
    } catch (err) {
      return 0;
    }
  }

  function cropUntil(pdf, checkFunction, callback) {
    async.during(
      (next) => {
        return checkFunction(next);
      },
      (next) => {
        console.log(`Trying to cut ${pdf} 8pt more.`);
        exec(`pdfcrop --margins '0 -8 0 0' ${pdf} ${pdf}`, next);
      },
      callback
    );
  }

  function cropProblemUpperHeader(folder, data, upperOffset, bottomOffset, i, callback) {
    let page = data.startPage + i;
    return exec(`pdfcrop --margins '0 -${upperOffset} 0 -${bottomOffset}' ${folder}/${page}.pdf ${folder}/${page}.pdf`, callback);
  }

  function generateProblemPDF(folder, data, idx, callback) {
    let problemPageCount = data.endPage - data.startPage + 1;

    async.series([
      (next) => {
        let bottomOffset = 0;
        if (hasFooter) {
          bottomOffset = 18;
        }
        async.timesSeries(problemPageCount, cropProblemUpperHeader.bind(null, folder, data, 0, bottomOffset), next);
      },
      (next) => {
        upperOffset = getUpperOffset(`${folder}/${data.startPage}.pdf`);
        console.log('Using upper offset ' + upperOffset);
        async.timesSeries(problemPageCount, cropProblemUpperHeader.bind(null, folder, data, upperOffset, 0), next);
      },
      (next) => {
        let pdfs = '';
        for (let i = data.startPage; i <= data.endPage; i++) {
          pdfs += ` ${folder}/${i}.pdf`;
        }
        exec(`pdfjam ${pdfs} --nup 1x${problemPageCount} --outfile ${folder}/p${idx}.pdf`, next);
      },
      (next) => {
        exec(`pdfcrop ${folder}/p${idx}.pdf ${folder}/p${idx}.pdf`, next);
      },
      (next) => {
        let pdf = `${folder}/p${idx}.pdf`;
        cropUntil(pdf, checkProblemMetadata.bind(null, pdf, 0), next);
      },
    ], callback);
  }

  function hasMetadata(text) {
    let metadata = [];
    try {
      metadata = _.chain(_.split(text, '\n').slice(0, 30))
        .map((o) => {
          if (/Problem.*?[.:]/.exec(o)) return 'name';
          if (/Time[^:]*:/.exec(o)) return 'tl';
          if (/Memory[^:]*:/.exec(o)) return 'ml';
          if (/Input[^:]*:/.exec(o)) return 'input';
          if (/Output[^:]*:/.exec(o)) return 'output';
          return null;
        })
        .filter()
        .uniq()
        .value()
    } catch (e) {}
    return metadata.length > 0 ? metadata : null;
  }

  function checkProblemMetadata(pdf, i, callback) {
    exec(`pdftotext ${pdf} -f ${i+1} -l ${i+1} -`, (err, stdout, stderr) => {
      if (err) {
        return callback(err);
      }
      return callback(null, hasMetadata(stdout));
    });
  }

  function importProblem(folder, problem, i, callback) {
    S3.upload({
        Key: `assets/problems/${problem.oj}/${problem.id}.pdf`,
        Body: fs.createReadStream(`${folder}/p${i}.pdf`),
        ACL: 'public-read',
        CacheControl: 'max-age=31536000'}, (err, details) => {
      problem.fullName = null;
      problem.importDate = new Date();
      problem.imported = true;
      problem.url = Utils.getURIFromS3Metadata(details);
      console.log(`>>> Imported in batch ${problem.id} from ${problem.oj} (${problem._id}). ${problem.url}`);
      return problem.save(callback);
    });
  }

  this.generatePdfs = (url, folderPrefix, callback) => {
    let allPdfFile, numberOfPages;
    let folder;
    let problemsIdx = [];
    async.waterfall([
      (next) => {
        return fs.mkdtemp(`${folderPrefix}/pdf`, next); // change
      },
      (_folder, next) => {
        folder = _folder;
        request({url: url, encoding: null}, next);
      },
      (res, body, next) => {
        allPdfFile = path.join(folder, 'all.pdf');
        fs.writeFile(allPdfFile, body, next);
      },
      (next) => {
        exec(`pdftk ${allPdfFile} dump_data | grep NumberOfPages | cut -d' ' -f2-`, next);
      },
      (stdout, stderr, next) => {
        numberOfPages = parseInt(stdout);
        async.timesSeries(numberOfPages, checkProblemMetadata.bind(null, allPdfFile), next);
      },
      (_data, next) => {
        problemsIdx = [];
        for (let i = 0; i < _data.length; i++) {
          if (!_data[i]) continue;
          if (!allMetadata) allMetadata = _data[i];
          let j = i+1;
          while (j < _data.length && !_data[j]) j++;
          problemsIdx.push({
            startPage: i+1,
            endPage: j,
          });
          i = j-1;
        }
        if (problemsIdx.length === 0) {
          return next("Cannot import problems :(");
        }
        console.log(problemsIdx);
        exec(`pdftk ${allPdfFile} burst output ${folder}/%d.pdf`, next);
      },
      (stdout, stderr, next) => {
        hasFooter = false;
        try {
          let text = getPDFTextWithHeight(`${folder}/${problemsIdx[0].startPage}.pdf`, 10000);
          text = _.split(text, '\n');
          text = _.filter(text, (o) => o.length > 0);
          text = text.slice(-5);
          hasFooter = _.some(text, (o) => o.match(/\s*Page\s+\d+/));
        } catch (err) { return next(err); }
        async.eachOfSeries(problemsIdx, generateProblemPDF.bind(null, folder), next);
      },
    ], (err) => {
      return callback(err, folder, problemsIdx.length);
    });
  }

  this.importProblemset = (problem, callback) => {
    if (triedUrls[problem.originalUrl]) {
      if (triedUrls[problem.originalUrl].success) {
        return callback(Errors.NoNeedToImport);
      } else {
        return callback(Errors.ImportFailed);
      }
    }
    triedUrls[problem.originalUrl] = { tried: true };
    let folder, problems;
    console.log(`Loading ${problem.originalUrl}...`);
    async.waterfall([
      (next) => {
        Problem.find({originalUrl: problem.originalUrl}, next);
      },
      (_problems, next) => {
        problems = _problems;
        problems.sort((a, b) => {
          if (isNaN(a)) {
            return a.id.localeCompare(b.id);
          }
          if (parseInt(a.id) < parseInt(b.id)) return -1;
          else if (parseInt(a.id) === parseInt(b.id)) return 0;
          return 1;
        })
        this.generatePdfs(problem.originalUrl, '.', next);
      },
      (_folder, importedCount, next) => {
        if (importedCount !== problems.length) {
          return next("Mismatch with the expected number of problems :(");
        }
        folder = _folder;
        async.eachOf(problems, importProblem.bind(null, folder), next);
      },
      (next) => {
        return fs.remove(folder, next);
      },
    ], (err) => {
      if (err) {
        console.log(err);
      } else {
        triedUrls[problem.originalUrl] = { success: true };
        console.log('> Loaded.');
      }
      return callback(Errors.NoNeedToImport);
    });
  }

  return this;
}
