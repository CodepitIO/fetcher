const request = require('request');
const fs = require('fs');
const scissors = require('scissors');

function foo(url) {
  request({url: url, encoding: null}, (err, res, body) => {
    fs.writeFileSync('test.pdf', body);
   	var pdf = scissors('test.pdf').pages(1).crop(570, 705, 0, 0);
   	let fname = __dirname + '/test2.pdf';
    pdf.pdfStream().pipe(fs.createWriteStream(fname)).on('finish', () => {
		// require('child_process').execSync(`pdftk ${fname} cat 1-endsouth output test3.pdf`);
		// var pdf2 = scissors('test3.pdf').crop(0, 0, 0, 0);
		// let fname2 = __dirname + '/test4.pdf';
		// pdf2.pdfStream().pipe(fs.createWriteStream(fname2)).on('finish', () => {
		// 	console.log('Over!');
		// });
    });
  });
}

foo('http://codeforces.com/gym/101336/attachments/download/5410/contest-5681-en.pdf');
