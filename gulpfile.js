const {src, dest} = require('gulp');

function copyIcons() {
	return src(['nodes/**/*.{png,svg}', 'credentials/**/*.{png,svg}'], {base: '.', encoding: false}).pipe(dest('dist'));
}

exports['build:icons'] = copyIcons;
