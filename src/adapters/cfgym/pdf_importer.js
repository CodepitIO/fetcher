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

module.exports = function(problem, callback) {
  let upperOffset;
  let allMetadata;

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
      return Math.ceil((i+1) * 0.75);
    } catch (err) {
      return 0;
    }
  }

  function getHeaderOffset(file) {
    try {
      let i = 0, j = 256;
      while (i < j) {
        let k = Math.ceil((i + j) / 2);
        let metadata = hasMetadata(getPDFTextWithHeight(file, k));
        if (metadata && metadata.length === allMetadata.length) {
          j = k - 1;
        } else {
          i = k;
        }
      }
      return Math.ceil((i+1) * 0.75);
    } catch (err) {
      console.log(err);
      return 0;
    }
  }

  function cropProblemPage(folder, data, i, callback) {
    let page = data.startPage + i;
    return exec(`pdfcrop --margins '0 -${upperOffset} 0 -18' ${folder}/${page}.pdf ${folder}/${page}.pdf`, callback);
  }

  function generateProblemPDF(folder, data, idx, callback) {
    let problemPageCount = data.endPage - data.startPage + 1;
    async.series([
      (next) => {
        async.timesSeries(problemPageCount, cropProblemPage.bind(null,folder,data), next);
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
        let headerOffset = getHeaderOffset(`${folder}/p${idx}.pdf`);
        console.log(`Header offset for ${idx} = ${headerOffset}`);
        exec(`pdfcrop --margins '0 -${headerOffset} 0 0' ${folder}/p${idx}.pdf ${folder}/p${idx}.pdf`, next);
      },
      (next) => {
        async.during(
          (callback) => {
            return checkProblemMetadata(`${folder}/p${idx}.pdf`, 0, callback);
          },
          (callback) => {
            console.log(`Trying to cut ${folder}/p${idx} 15pt more.`);
            exec(`pdfcrop --margins '0 -12 0 0' ${folder}/p${idx}.pdf ${folder}/p${idx}.pdf`, callback);
          },
          next
        );
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

  function importer(problem, callback) {
    let folder, allPdfFile, numberOfPages;
    if (triedUrls[problem.originalUrl]) {
      if (triedUrls[problem.originalUrl].success) {
        return callback(Errors.NoNeedToImport);
      } else {
        return callback(Errors.ImportFailed);
      }
    }
    triedUrls[problem.originalUrl] = { tried: true };
    let problemsIdx = [];
    let problems;
    console.log(`Loading ${problem.originalUrl}...`);
    async.waterfall([
      (next) => {
        Problem.find({originalUrl: problem.originalUrl}, next);
      },
      (_problems, next) => {
        problems = _problems;
        return fs.mkdtemp('/tmp/pdf', next); // change
      },
      (_folder, next) => {
        folder = _folder;
        request({url: problem.originalUrl, encoding: null}, next);
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
        for (let i = 0; i < _data.length; i++) {
          if (!_data[i]) continue;
          allMetadata = _data[i];
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
        if (problemsIdx.length !== problems.length) {
          return next("Mismatch with the expected number of problems :(");
        }
        exec(`pdftk ${allPdfFile} burst output ${folder}/%d.pdf`, next);
      },
      (stdout, stderr, next) => {
        upperOffset = getUpperOffset(`${folder}/1.pdf`, next);
        console.log('Using offset ' + upperOffset);
        async.eachOfSeries(problemsIdx, generateProblemPDF.bind(null, folder), next);
      },
      (next) => {
        problems.sort((a, b) => {
          if (isNaN(a)) {
            return a.id.localeCompare(b.id);
          }
          if (parseInt(a.id) < parseInt(b.id)) return -1;
          else if (parseInt(a.id) === parseInt(b.id)) return 0;
          return 1;
        })
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

  return importer(problem, callback);
}
