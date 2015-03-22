// Copyright 2012 Traceur Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

var fs = require('fs');
var path = require('path');
var Promise = require('rsvp').Promise;
var nodeLoader = require('./nodeLoader.js');
var util = require('./file-util.js');
var normalizePath = util.normalizePath;
var mkdirRecursive = util.mkdirRecursive;
var NodeCompiler = require('./NodeCompiler.js').NodeCompiler;

var cwd = process.cwd();

function revertCwd() {
  process.chdir(cwd);
}

function recursiveModuleCompileToSingleFile(outputFile, includes, options) {
  var resolvedOutputFile = path.resolve(outputFile);
  var outputDir = path.dirname(resolvedOutputFile);

  // Resolve includes before changing directory.
  var resolvedIncludes = includes.map(function(include) {
    include.name = path.resolve(include.name);
    return include;
  });

  options.bundle = includes.length > 1;
  var compiler = new NodeCompiler(options);

  mkdirRecursive(outputDir);
  process.chdir(outputDir);
  // Make includes relative to output dir so that sourcemap paths are correct.
  resolvedIncludes = resolvedIncludes.map(function(include) {
    include.name = normalizePath(path.relative(outputDir, include.name));
    return include;
  });

  return recursiveModuleCompile(resolvedIncludes, options)
      .then(function(tree) {
        compiler.writeTreeToFile(tree, resolvedOutputFile);
      }).then(revertCwd, function(err) {
        revertCwd();
        throw err;
      });
}

function forEachRecursiveModuleCompile(outputDir, includes, options) {
  var outputDir = path.resolve(outputDir);
  var compiler = new NodeCompiler(options);
  function getPromise (input) {
    return recursiveModuleCompile([input], options).then(function(tree) {
      var outputFileName = path.join(outputDir, input.name);
      compiler.writeTreeToFile(tree, outputFileName);
    });
  }
  return Promise.all(includes.map(getPromise));
}

var TraceurLoader = traceur.runtime.TraceurLoader;
var InlineLoaderCompiler = traceur.runtime.InlineLoaderCompiler;
var Options = traceur.util.Options;

/**
 * Chains .then() calls along a list after applying a function. The function
 * is not called on a value in the list until the promise generated by calling
 * the function on the previous value in the list completes.
 *
 * @param {Array.<T>} list
 * @param {function(T): Promise<?>} f A function applied to each item on the
 *     list.
 * @return {Promise<?>} A promise where each promise f(v), for each v in the
 *     list has completed.
 */
function sequencePromises(list, f) {
  var result = Promise.resolve();
  list.forEach(function (item) {
    result = result.then(function() { return f(item); });
  });
  return result;
}

/**
 * Compiles the files in "fileNamesAndTypes" along with any associated modules,
 * into a single js file, in module dependency order.
 *
 * @param {Array.<Object>} fileNamesAndTypes The list of {name, type}
 *     to compile and concat; type is 'module' or 'script'
 * @param {Object} options A container for misc options. 'depTarget' is the
 *     only currently available option, which results in the dependencies for
 *     'fileNamesAndTypes' being printed to stdout, with 'depTarget' as the target.
 * @param {Function} callback Callback used to return the result. A null result
 *     indicates that recursiveModuleCompile has returned successfully from a
 *     non-compile request.
 * @param {Function} errback Callback used to return errors.
 */
function recursiveModuleCompile(fileNamesAndTypes, options) {
  var depTarget = options && options.depTarget;
  var referrerName = options && options.referrer;

  var basePath = path.resolve('./') + '/';
  basePath = basePath.replace(/\\/g, '/');

  var elements = [];
  var loaderCompiler = new InlineLoaderCompiler(elements);

  var loader = new TraceurLoader(nodeLoader, basePath, loaderCompiler);

  function appendEvaluateModule(name) {
    var normalizedName =
        traceur.ModuleStore.normalize(name, referrerName);
    // Create tree for System.get('normalizedName');
    var moduleModule = traceur.codegeneration.module;
    var tree = moduleModule.createModuleEvaluationStatement(normalizedName);
    elements.push(tree);
  }

  function loadInput(input) {
    var doEvaluateModule = false;
    var loadFunction = loader.import;
    var name = input.name;

    var optionsCopy = new Options(options); // Give each load a copy of options.

    if (input.type === 'script') {
      loadFunction = loader.loadAsScript;
    } else if (optionsCopy.modules === 'register') {
      doEvaluateModule = true;
    }

    var loadOptions = {
      referrerName: referrerName,
      metadata: {traceurOptions: optionsCopy}
    };

    return loadFunction.call(loader, name, loadOptions).then(function() {
      if (doEvaluateModule) {
        appendEvaluateModule(name);
      }
    });
  }

  return sequencePromises(fileNamesAndTypes, loadInput).then(function() {
    if (depTarget) {
      return null;
    } else {
      return loaderCompiler.toTree();
    }
  });
}

exports.recursiveModuleCompileToSingleFile = recursiveModuleCompileToSingleFile;
exports.forEachRecursiveModuleCompile = forEachRecursiveModuleCompile;
