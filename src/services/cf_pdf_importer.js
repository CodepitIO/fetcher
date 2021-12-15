const request   = require('request'),
      fs        = require('fs-extra'),
      path      = require('path'),
      async     = require('async'),
      exec      = require('child_process').exec,
      execSync  = require('child_process').execSync,
      _ = require('lodash');

const Problem       = require('../../common/models/problem'),
      S3            = require('./dbs').S3,
      Errors        = require('../../common/errors'),
      Utils         = require('../../common/lib/utils'),
      LangDetector  = new (require('languagedetect'));

let triedUrls = {};

module.exports = function() {
  let hasFooter, upperOffset;

  function getPDFTextSync(file) {
    try {
      let out = execSync(`pdftotext ${file} -`);
      return out.toString('utf8');
    } catch (e) {}
    return null;
  }

  function getUpperOffset(file) {
    try {
      let i = 0, j = 256;
      while (i < j) {
        let k = Math.ceil((i + j) / 2);
        execSync(`pdfcrop --margins '0 -${k} 0 0' ${file} ${file}.tmp.pdf`);
        let text = getPDFTextSync(file + '.tmp.pdf');
        let hasName = getName(_.split(text, '\n').slice(0, 15));
        if (!hasName) {
          j = k - 1;
        } else {
          i = k;
        }
      }
      i = 0;
      while (i < j) {
        let k = Math.ceil((i + j) / 2);
        execSync(`pdfcrop --margins '0 -${k} 0 0' ${file} ${file}.tmp.pdf`);
        let text = getPDFTextSync(file + '.tmp.pdf');
        let hasName = getName(_.split(text, '\n').slice(0, 1));
        if (hasName) {
          j = k - 1;
        } else {
          i = k;
        }
      }
      return i + 5;
    } catch (err) {
      return 0;
    }
  }

  function getMetadataOffset(file) {
    try {
      let i = 0, j = 256;
      while (i < j) {
        let k = Math.ceil((i + j) / 2);
        execSync(`pdfcrop --margins '0 -${k} 0 0' ${file} ${file}.tmp.pdf`);
        let text = getPDFTextSync(file + '.tmp.pdf');
        let has = hasMetadata(_.split(text, '\n').slice(0, 15));
        if (!has) {
          j = k - 1;
        } else {
          i = k;
        }
      }
      return i + 5;
    } catch (err) {
      return 0;
    }
  }

  function cropProblemUpperHeader(folder, data, upper, bottom, i, callback) {
    let page = data.startPage + i;
    return exec(`pdfcrop --margins '0 -${upper} 0 -${bottom}' ${folder}/${page}.pdf ${folder}/${page}.pdf`, callback);
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
        let metadataOffset = getMetadataOffset(pdf);
        exec(`pdfcrop --margins '0 -${metadataOffset} 0 0' ${pdf} ${pdf}`, next);
      },
    ], callback);
  }

  function hasMetadata(texts) {
    let metadata = [];
    try {
      metadata = _.chain(texts)
        .map((o) => {
          if (/^\s*Problema?\s*([\w\d]{0,3})[.:]\s*(.+)?\s*$/.exec(o)) return 'name';
          if (/^\s*Problem\s+ID\s*[.:]\s*(.+)?\s*$/.exec(o)) return 'id';
          if (/^\s*Time[^:]{0,10}:/.exec(o)) return 'tl';
          if (/^\s*Limite\s*de\s*tempo[^:]{0,10}:/.exec(o)) return 'tl';
          if (/^\s*Memory[^:]{0,10}:/.exec(o)) return 'ml';
          if (/^\s*Input[^:]{0,10}:/.exec(o)) return 'input';
          if (/^\s*Output[^:]{0,10}:/.exec(o)) return 'output';
          if (/^\s*Arquivo-fonte[^:]{0,10}:/.exec(o)) return 'output';
          return null;
        })
        .filter()
        .uniq()
        .value();
    } catch (e) {}
    return metadata && metadata.length > 0;
  }

  function getName(texts) {
    let metadata = [];
    try {
      metadata = _.chain(texts)
        .map((o, i) => {
          let name = null;
          let match = /^\s*Problema?\s*([\w\d]{0,3})[.:]\s*(.+)?\s*$/.exec(o);
          if (match) name = match[2];
          let match2 = /^\s*Problema?\s*([A-Z]|[1-9]{1,2})\s*$/.exec(o);
          if (match2) name = texts[i+1];
          if (name && name.length > 50) name = null;
          return name;
        })
        .filter()
        .uniq()
        .value();
    } catch (e) {}
    return metadata && metadata.length > 0 && metadata[0];
  }

  function checkProblemName(pdf, i, callback) {
    exec(`pdftotext ${pdf} -f ${i+1} -l ${i+1} -`, (err, stdout, stderr) => {
      if (err) {
        return callback(err);
      }
      return callback(null, getName(_.split(stdout, '\n').slice(0, 15)));
    });
  }

  function importProblem(language, folder, data, problem, i, callback) {
    S3.upload({
        Key: `assets/problems/${problem.oj}/${problem.id}.pdf`,
        Body: fs.createReadStream(`${folder}/p${i}.pdf`),
        ACL: 'public-read',
        CacheControl: 'max-age=31536000'}, (err, details) => {
      if (err) {
        return callback(err);
      }
      if (problem.name.length <= 2 && data[i].name.length > 2) {
        problem.name = data[i].name;
      }
      problem.fullName = null;
      problem.language = language;
      problem.importDate = new Date();
      problem.imported = true;
      problem.url = Utils.getURIFromS3Metadata(details);
      console.log(`>>> Imported in batch ${problem.id} from ${problem.oj} (${problem._id}). ${problem.url}`);
      return problem.save(callback);
    });
  }

  function generatePdfs(url, folderPrefix, callback) {
    let allPdfFile, numberOfPages, language;
    let folder;
    let problemsIdx = [];
    console.log(`Loading ${url}...`);
    async.waterfall([
      (next) => {
        return fs.ensureDir(folderPrefix, next);
      },
      (dir, next) => {
        return fs.mkdtemp(`${folderPrefix}/pdf`, next);
      },
      (_folder, next) => {
        folder = _folder;
        request({url: encodeURI(url), encoding: null}, next);
      },
      (res, body, next) => {
        allPdfFile = path.join(folder, 'all.pdf');
        fs.writeFile(allPdfFile, body, next);
      },
      (next) => {
        exec(`pdftk ${allPdfFile} dump_data | grep NumberOfPages | cut -d' ' -f2-`, next);
      },
      (stdout, stderr, next) => {
        if (stderr) return next(stderr);
        numberOfPages = parseInt(stdout);
        async.timesSeries(numberOfPages, checkProblemName.bind(null, allPdfFile), next);
      },
      (_data, next) => {
        problemsIdx = [];
        for (let i = 0; i < _data.length; i++) {
          if (!_data[i]) continue;
          let j = i+1;
          while (j < _data.length && !_data[j]) j++;
          problemsIdx.push({
            name: _data[i],
            startPage: i+1,
            endPage: j,
          });
          i = j-1;
        }
        if (problemsIdx.length === 0) {
          return next("Cannot import problems :(");
        }
        exec(`pdftk ${allPdfFile} burst output ${folder}/%d.pdf`, next);
      },
      (stdout, stderr, next) => {
        hasFooter = false;
        try {
          let text = getPDFTextSync(`${folder}/${problemsIdx[0].startPage}.pdf`);
          text = _.split(text, '\n');
          text = _.filter(text, (o) => o.length > 0);
          text = text.slice(-5);
          hasFooter = _.some(text, (o) => {
            if (o.match(/\s*Page\s+\d+/)) return true;
            if (o.match(/^\s*Pagina\s*\d*/)) return true;
            return false;
          });
        } catch (err) { return next(err); }
        upperOffset = getUpperOffset(`${folder}/${problemsIdx[0].startPage}.pdf`);
        let langs = LangDetector.detect(getPDFTextSync(`${folder}/${problemsIdx[0].startPage}.pdf`));
        language = langs && langs.length > 0 && langs[0] || 'english';
        async.eachOfSeries(problemsIdx, generateProblemPDF.bind(null, folder), next);
      },
    ], (err) => {
      return callback(err, folder, language, problemsIdx);
    });
  };

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
    console.log(`Importing problemset of contest ${problem.id}`);
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
        });
        generatePdfs(problem.originalUrl, '/tmp', next);
      },
      (_folder, language, data, next) => {
        if (data.length !== problems.length) {
          return next("Mismatch with the expected number of problems :(");
        }
        folder = _folder;
        async.eachOf(problems, importProblem.bind(null, language, folder, data), next);
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
  };

  return this;
};
