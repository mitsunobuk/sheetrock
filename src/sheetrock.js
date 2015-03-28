/*!
 * Sheetrock v0.3.0
 * Quickly connect to, query, and lazy-load data from Google Sheets.
 * http://chriszarate.github.io/sheetrock/
 * License: MIT
 */

/*global define, global */
/*jslint indent: 2, node: true, vars: true */

(function (name, root, factory) {

  'use strict';

  if (typeof define === 'function' && define.amd) {
    define(function () {
      return factory(null, root);
    });
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('request'), global || root);
  } else {
    root[name] = factory(null, root);
  }

}('sheetrock', this, function (requestModule, window) {

  'use strict';

  // Google Visualization API endpoints and parameter formats
  var sheetTypes = {
    '2014': {
      'apiEndpoint': 'https://docs.google.com/spreadsheets/d/%key%/gviz/tq?',
      'keyFormat': new RegExp('spreadsheets/d/([^/#]+)', 'i'),
      'gidFormat': new RegExp('gid=([^/&#]+)', 'i')
    },
    '2010': {
      'apiEndpoint': 'https://spreadsheets.google.com/tq?key=%key%&',
      'keyFormat': new RegExp('key=([^&#]+)', 'i'),
      'gidFormat': new RegExp('gid=([^/&#]+)', 'i')
    }
  };

  // Placeholder for request status cache
  var requestStatusCache = {
    loaded: {},
    failed: {},
    offset: {}
  };

  // JSONP callback function index
  var jsonpCallbackIndex = 0;

  // DOM and transport settings
  var document = window.document;
  var useJSONPTransport = typeof requestModule !== 'function';


  /* Polyfills */

  // Radically simplified polyfills for narrow use cases.

  if (!Array.prototype.forEach) {
    /*jshint freeze: false */
    Array.prototype.forEach = function (func) {
      var i;
      var array = this;
      var arrayLength = array.length;
      for (i = 0; i < arrayLength; i = i + 1) {
        func(array[i], i);
      }
    };
  }

  if (!Array.prototype.map) {
    /*jshint freeze: false */
    Array.prototype.map = function (func) {
      var array = this;
      var resultArray = [];
      array.forEach(function (value, i) {
        resultArray[i] = func(value);
      });
      return resultArray;
    };
  }

  if (!Object.keys) {
    Object.keys = function (object) {
      var key;
      var array = [];
      for (key in object) {
        if (object.hasOwnProperty(key)) {
          array.push(key);
        }
      }
      return array;
    };
  }


  /* Helpers */

  // General error handler.
  var handleError = function (error, options, rawData) {

    if (!(error instanceof Error)) {
      error = new Error(error);
    }

    // Remember that this request failed.
    if (options && options.request && options.request.index) {
      requestStatusCache.failed[options.request.index] = true;
    }

    // Call the user's callback function.
    if (options.user.callback) {
      options.user.callback(error, options, rawData || null, null, null);
    }

  };

  // Trim a string of leading and trailing spaces.
  var trim = function (str) {
    return str.toString().replace(/^ +/, '').replace(/ +$/, '');
  };

  // Parse a string as a natural number (>=0).
  var stringToNaturalNumber = function (str) {
    return Math.max(0, parseInt(str, 10) || 0);
  };

  // Return true if an object has all of the passed arguments as properties.
  var has = function (obj) {
    var i;
    var length = arguments.length;
    for (i = 1; i < length; i = i + 1) {
      if (obj[arguments[i]] === undefined) {
        return false;
      }
    }
    return true;
  };

  // Extract a DOM element from a possible jQuery blob.
  var extractElement = function (blob) {
    blob = blob || {};
    if (blob.jquery && blob.length) {
      blob = blob[0];
    }
    return (blob.nodeType && blob.nodeType === 1) ? blob : false;
  };

  var extendDefaults = function (defaults, options) {
    var extended = {};
    var defaultKeys = Object.keys(defaults);
    defaultKeys.forEach(function (key) {
      extended[key] = (options.hasOwnProperty(key)) ? options[key] : defaults[key];
    });
    return extended;
  };

  // Get API endpoint, key, and gid from a Google Sheet URL.
  var getRequestOptions = function (url) {
    var requestOptions = {};
    var sheetTypeKeys = Object.keys(sheetTypes);
    sheetTypeKeys.forEach(function (key) {
      var sheetType = sheetTypes[key];
      if (sheetType.keyFormat.test(url) && sheetType.gidFormat.test(url)) {
        requestOptions.key = url.match(sheetType.keyFormat)[1];
        requestOptions.gid = url.match(sheetType.gidFormat)[1];
        requestOptions.apiEndpoint = sheetType.apiEndpoint.replace('%key%', requestOptions.key);
      }
    });
    return requestOptions;
  };

  // Extract the label, if present, from a column object, sans white space.
  var getColumnLabel = function (col) {
    return (has(col, 'label')) ? col.label.replace(/\s/g, '') : null;
  };

  // Map function: Return the label or letter of a column object.
  var getColumnLabelOrLetter = function (col) {
    return getColumnLabel(col) || col.id;
  };

  // Convert an array to a object.
  var arrayToObject = function (array) {
    var object = {};
    array.forEach(function (value) {
      object[value] = value;
    });
    return object;
  };

  // Wrap a string in tag. The style argument, if present, is populated into
  // an inline CSS style attribute. (Gross!)
  var wrapTag = function (str, tag) {
    return '<' + tag + '>' + str + '</' + tag + '>';
  };

  // Default row template: Output a row object as an HTML table row. Use "td"
  // for table body row, "th" for table header rows.
  var toHTML = function (row) {
    var tag = (row.num) ? 'td' : 'th';
    var cells = Object.keys(row.cells);
    var html = '';
    cells.forEach(function (key) {
      html += wrapTag(row.cells[key], tag);
    });
    return wrapTag(html, 'tr');
  };

  // If user requests it, reset any cached request status.
  var resetRequestStatus = function (index) {
    requestStatusCache.loaded[index] = false;
    requestStatusCache.failed[index] = false;
    requestStatusCache.offset[index] = 0;
  };


  /* Options */

  // Check the user-passed options for correctable problems.
  var checkUserOptions = function (target, options) {

    // Support some legacy option names.
    options.query = options.sql || options.query;
    options.reset = options.resetStatus || options.reset;
    options.rowHandler = options.rowHandler || options.rowTemplate;

    // Look for valid DOM element target.
    options.target = extractElement(options.target) || extractElement(target);

    // Correct bad integer values.
    options.headers = stringToNaturalNumber(options.headers);
    options.chunkSize = stringToNaturalNumber(options.chunkSize);

    return options;

  };

  // Process user-passed options.
  var processUserOptions = function (target, options) {

    var userOptions = checkUserOptions(target, options);
    var requestOptions = getRequestOptions(userOptions.url);
    var debugMessages = [];

    // Set request query and index (key_gid_query).
    requestOptions.query = userOptions.query;
    requestOptions.index = requestOptions.key + '_' + requestOptions.gid + '_' + userOptions.query;

    // If requested, reset request status.
    if (userOptions.reset && requestOptions.index) {
      resetRequestStatus(requestOptions.index);
      debugMessages.push('Request status has been reset.');
    }

    // Retrieve current row offset.
    userOptions.offset = requestStatusCache.offset[requestOptions.index] || 0;

    // If requested, make a request for chunked data.
    if (userOptions.chunkSize && requestOptions.index) {

      // Append a limit and row offest to the query to target the next chunk.
      requestOptions.query += ' limit ' + (userOptions.chunkSize + 1);
      requestOptions.query += ' offset ' + userOptions.offset;

      // Remember the new row offset.
      requestStatusCache.offset[requestOptions.index] = userOptions.offset + userOptions.chunkSize;

    }

    return {
      user: userOptions,
      request: requestOptions,
      debug: debugMessages
    };

  };

  // Validate the processed options hash.
  var validateOptions = function (options) {

    // Require DOM element or a callback function. Otherwise, the data has nowhere to go.
    if (!options.user.target && !options.user.callback) {
      throw 'No element targeted or callback provided.';
    }

    // Require a Sheet key and gid.
    if (!(options.request.key && options.request.gid)) {
      throw 'No key/gid in the provided URL.';
    }

    // Abandon requests that have previously generated an error.
    if (requestStatusCache.failed[options.request.index]) {
      throw 'A previous request for this resource failed.';
    }

    // Abandon requests that have already been loaded.
    if (requestStatusCache.loaded[options.request.index]) {
      throw 'No more rows to load!';
    }

    return options;

  };


  /* Data */

  // Get useful information about the response.
  var getResponseAttributes = function (options, data) {

    // Initialize a hash for the response attributes.
    var attributes = {};

    var chunkSize = options.user.chunkSize;
    var labels = options.user.labels;
    var rows = data.table.rows;
    var cols = data.table.cols;

    // The Google API generates an unrecoverable error when the 'offset' is
    // larger than the number of available rows, which is problematic for
    // chunked requests. As a workaround, we request one more row than we need
    // and stop when we see less rows than we requested.

    // Calculate the last returned row.
    attributes.last = Math.min(rows.length, chunkSize || rows.length);

    // Remember whether this request has been fully loaded.
    requestStatusCache.loaded[options.request.index] = !chunkSize || attributes.last < chunkSize;

    // Determine if Google has extracted column labels from a header row.
    attributes.header = (cols.map(getColumnLabel).length) ? 1 : 0;

    // If no column labels are provided or if there are too many or too few
    // compared to the returned data, use the returned column labels.
    attributes.labels = (labels && labels.length === cols.length) ? labels : cols.map(getColumnLabelOrLetter);

    // Return the response attributes.
    return attributes;

  };

  // Enumerate any messages embedded in the API response.
  var enumerateMessages = function (options, data, state) {

    // Look for the specified property at the root of the response object.
    if (has(data, state)) {
      data[state].forEach(function (status) {
        if (has(status, 'detailed_message')) {
          /*jshint camelcase: false */
          /*jscs: disable requireCamelCaseOrUpperCaseIdentifiers */
          options.debug.push(status.detailed_message);
          /*jscs: enable */
        } else if (has(status, 'message')) {
          options.debug.push(status.message);
        }
      });
    }

  };

  // Parse data, row by row, and generate a simpler output array.
  var parseData = function (options, rawData) {

    var output = [];

    // Add a header row constructed from the column labels, if appropriate.
    if (!options.user.offset) {
      output.push({
        num: 0,
        cells: arrayToObject(options.response.labels)
      });
    }

    // Each table cell ('c') can contain two properties: 'p' contains
    // formatting and 'v' contains the actual cell value.

    // Loop through each table row.
    rawData.table.rows.forEach(function (row, i) {

      // Proceed if the row has cells and the row index is within the targeted
      // range. (This avoids displaying too many rows when chunking data.)
      if (has(row, 'c') && i < options.response.last) {

        // Get the "real" row index (not counting header rows).
        var counter = stringToNaturalNumber(options.user.offset + i + 1 + options.response.header - options.user.headers);

        // Initialize a row object, which will be added to the output array.
        var rowObject = {
          num: counter,
          cells: {}
        };

        // Loop through each cell in the row.
        row.c.forEach(function (cell, x) {

          // Extract cell value.
          var value = (cell && has(cell, 'v') && cell.v) ? cell.v : '';

          // Avoid array cell values.
          if (value instanceof Array) {
            value = (has(cell, 'f')) ? cell.f : value.join('');
          }

          // Add the trimmed cell value to the row object, using the desired
          // column label as the key.
          rowObject.cells[options.response.labels[x]] = trim(value);

        });

        // Add to the output array.
        output.push(rowObject);

      }

    });

    return output;

  };

  // Append HTML output to DOM.
  var appendHTMLToDOM = function (target, headerHTML, bodyHTML) {

    // Use row group tags (<thead>, <tbody>) if the target is a table.
    if (target.tagName === 'TABLE') {
      var headerElement = document.createElement('thead');
      var bodyElement = document.createElement('tbody');
      headerElement.innerHTML = headerHTML;
      bodyElement.innerHTML = bodyHTML;
      target.appendChild(headerElement);
      target.appendChild(bodyElement);
    } else {
      target.insertAdjacentHTML('beforeEnd', headerHTML + bodyHTML);
    }

  };

  // Generate HTML using a template.
  var generateHTML = function (options, tableArray) {

    var template = options.user.rowTemplate || toHTML;
    var hasDOMTarget = document && document.createElement && options.user.target;
    var isTable = hasDOMTarget && options.user.target.tagName === 'TABLE';

    var headerHTML = '';
    var bodyHTML = '';

    // Pass each row to the row template and append the output to either the
    // header or body section.
    tableArray.forEach(function (row) {
      if (row.num) {
        bodyHTML += template(row);
      } else {
        headerHTML += template(row);
      }
    });

    if (hasDOMTarget) {
      appendHTMLToDOM(options.user.target, headerHTML, bodyHTML);
    }

    return (isTable) ? wrapTag(headerHTML, 'thead') + wrapTag(bodyHTML, 'tbody') : headerHTML + bodyHTML;

  };

  // Process API response.
  var processResponse = function (options, rawData) {

    enumerateMessages(options, rawData, 'warnings');
    enumerateMessages(options, rawData, 'errors');

    // Make sure the response is populated with actual data.
    if (has(rawData, 'status', 'table') && has(rawData.table, 'cols', 'rows')) {

      // Add useful information about the response to the options hash.
      options.response = getResponseAttributes(options, rawData);

      // Parse the raw response data into a simple array of table rows.
      var tableArray = parseData(options, rawData);

      // Parse the table array into HTML.
      var outputHTML = generateHTML(options, tableArray);

      // Call the user's callback function.
      if (options.user.callback) {
        options.user.callback(null, options, rawData, tableArray, outputHTML);
      }

    } else {
      throw 'Unexpected API response format.';
    }

  };

  // Send a JSON requent.
  var requestJSON = function (options, callback) {

    // There is an issue with new Sheets causing the string ")]}'" to be
    // prepended to the JSON output when the X-DataSource-Auth is added.

    // https://code.google.com/p/google-visualization-api-issues/issues/detail?id=1928

    // Until this is fixed, load as text and manually strip with regex. :(

    var requestOptions = {
      headers: {
        'X-DataSource-Auth': 'true'
      },
      //json: true, <= temporary fix
      url: options.request.url
    };

    var responseCallback = function (responseError, response, body) {
      if (!responseError && response.statusCode === 200) {
        try {
          // Next line is a temporary fix.
          body = JSON.parse(body.replace(/^\)\]\}\'\n/, ''));
          callback(options, body);
        } catch (error) {
          handleError(error, options, body);
        }
      } else {
        handleError(responseError || 'Request failed.', options);
      }
    };

    requestModule(requestOptions, responseCallback);

  };

  // Send a JSONP requent.
  var requestJSONP = function (options, callback) {

    var headElement = document.getElementsByTagName('head')[0];
    var scriptElement = document.createElement('script');
    var callbackName = '_sheetrock_callback_' + jsonpCallbackIndex;

    var always = function () {
      headElement.removeChild(scriptElement);
      delete window[callbackName];
    };

    var success = function (data) {
      try {
        callback(options, data);
      } catch (error) {
        handleError(error, options, data);
      } finally {
        always();
      }
    };

    var error = function () {
      handleError('Request failed.', options);
      always();
    };

    window[callbackName] = success;

    options.request.url = options.request.url.replace('%callback%', callbackName);

    scriptElement.type = 'text/javascript';
    scriptElement.src = options.request.url;

    scriptElement.addEventListener('error', error);
    scriptElement.addEventListener('abort', error);

    headElement.appendChild(scriptElement);

    jsonpCallbackIndex = jsonpCallbackIndex + 1;

  };

  // Build a request URL using the user's options.
  var buildRequestURL = function (options) {

    var query = [
      'gid=' + encodeURIComponent(options.request.gid),
      'tq=' + encodeURIComponent(options.request.query)
    ];

    if (useJSONPTransport) {
      query.push('tqx=responseHandler:%callback%');
    }

    return options.request.apiEndpoint + query.join('&');

  };

  // Fetch data using the appropriate transport.
  var fetchData = function (options, callback) {

    options.request.url = buildRequestURL(options);

    if (useJSONPTransport) {
      requestJSONP(options, callback);
    } else {
      requestJSON(options, callback);
    }

  };

  /* API */

  // Documentation is available at:
  // https://github.com/chriszarate/sheetrock/

  // Changes to API in 1.0.0:
  // ------------------------
  // - *renamed* .options => .defaults
  // - *removed* .promise -- requests are no longer chained
  // - *removed* .working -- use callback function

  var defaults = {

    // Changes to defaults in 1.0.0:
    // -----------------------------
    // - *added* target
    // - *renamed* sql => query
    // - *renamed* resetStatus => reset
    // - *renamed* rowHandler => rowTemplate
    // - *removed* server -- pass data as parameter instead
    // - *removed* columns -- always use column letters in query
    // - *removed* cellHandler -- use rowTemplate for text formatting
    // - *removed* errorHandler -- errors are passed to callback function
    // - *removed* loading -- use callback function
    // - *removed* rowGroups -- <thead>, <tbody> added when target is <table>
    // - *removed* formatting -- almost useless, impossible to support
    // - *removed* headersOff -- use rowTemplate to show or hide rows
    // - *removed* debug -- compiled messages are passed to callback function

    url:          '',          // String  -- Google Sheet URL
    query:        '',          // String  -- Google Visualization API query
    target:       null,        // DOM Element -- An element to append output to
    chunkSize:    0,           // Integer -- Number of rows to fetch (0 = all)
    labels:       [],          // Array   -- Override *returned* column labels
    rowTemplate:  null,        // Function / Template
    callback:     null,        // Function
    headers:      0,           // Integer -- Number of header rows
    reset:        false        // Boolean -- Reset request status

  };

  var sheetrock = function (options, bootstrappedData) {

    try {

      options = extendDefaults(defaults, options);
      options = processUserOptions(this, options);
      options = validateOptions(options);

      if (bootstrappedData) {
        processResponse(options, bootstrappedData);
      } else {
        fetchData(options, processResponse);
      }

    } catch (error) {
      handleError(error, options);
    }

    return this;

  };

  sheetrock.defaults = defaults;
  sheetrock.version = '0.3.0';

  // If jQuery is available as a global, register as a plugin.
  if (window.jQuery && window.jQuery.fn && window.jQuery.fn.jquery) {
    window.jQuery.fn.sheetrock = sheetrock;
  }

  return sheetrock;

}));