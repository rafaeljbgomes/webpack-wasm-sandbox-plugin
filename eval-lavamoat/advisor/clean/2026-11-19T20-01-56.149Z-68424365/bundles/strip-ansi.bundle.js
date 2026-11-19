/*
 * ATTENTION: The "eval" devtool has been used (maybe by default in mode: "development").
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
var __SANDBOXED_LIB__;
/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./node_modules/ansi-regex/index.js"
/*!******************************************!*\
  !*** ./node_modules/ansi-regex/index.js ***!
  \******************************************/
(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {

eval("{__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (/* binding */ ansiRegex)\n/* harmony export */ });\nfunction ansiRegex({onlyFirst = false} = {}) {\n\t// Valid string terminator sequences are BEL, ESC\\, and 0x9c\n\tconst ST = '(?:\\\\u0007|\\\\u001B\\\\u005C|\\\\u009C)';\n\n\t// OSC sequences only: ESC ] ... ST (non-greedy until the first ST)\n\tconst osc = `(?:\\\\u001B\\\\][\\\\s\\\\S]*?${ST})`;\n\n\t// CSI and related: ESC/C1, optional intermediates, optional params (supports ; and :) then final byte\n\tconst csi = '[\\\\u001B\\\\u009B][[\\\\]()#;?]*(?:\\\\d{1,4}(?:[;:]\\\\d{0,4})*)?[\\\\dA-PR-TZcf-nq-uy=><~]';\n\n\tconst pattern = `${osc}|${csi}`;\n\n\treturn new RegExp(pattern, onlyFirst ? undefined : 'g');\n}\n\n\n//# sourceURL=webpack://sandbox-security-evaluation-app/./node_modules/ansi-regex/index.js?\n}");

/***/ },

/***/ "./node_modules/strip-ansi/index.js"
/*!******************************************!*\
  !*** ./node_modules/strip-ansi/index.js ***!
  \******************************************/
(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {

eval("{__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (/* binding */ stripAnsi)\n/* harmony export */ });\n/* harmony import */ var ansi_regex__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ansi-regex */ \"./node_modules/ansi-regex/index.js\");\n\n\nconst regex = (0,ansi_regex__WEBPACK_IMPORTED_MODULE_0__[\"default\"])();\n\nfunction stripAnsi(string) {\n\tif (typeof string !== 'string') {\n\t\tthrow new TypeError(`Expected a \\`string\\`, got \\`${typeof string}\\``);\n\t}\n\n\t// Fast path: ANSI codes require ESC (7-bit) or CSI (8-bit) introducer\n\tif (!string.includes('\\u001B') && !string.includes('\\u009B')) {\n\t\treturn string;\n\t}\n\n\t// Even though the regex is global, we don't need to reset the `.lastIndex`\n\t// because unlike `.exec()` and `.test()`, `.replace()` does it automatically\n\t// and doing it manually has a performance penalty.\n\treturn string.replace(regex, '');\n}\n\n\n//# sourceURL=webpack://sandbox-security-evaluation-app/./node_modules/strip-ansi/index.js?\n}");

/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		if (!(moduleId in __webpack_modules__)) {
/******/ 			delete __webpack_module_cache__[moduleId];
/******/ 			var e = new Error("Cannot find module '" + moduleId + "'");
/******/ 			e.code = 'MODULE_NOT_FOUND';
/******/ 			throw e;
/******/ 		}
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module can't be inlined because the eval devtool is used.
/******/ 	var __webpack_exports__ = __webpack_require__("./node_modules/strip-ansi/index.js");
/******/ 	__SANDBOXED_LIB__ = __webpack_exports__;
/******/ 	
/******/ })()
;