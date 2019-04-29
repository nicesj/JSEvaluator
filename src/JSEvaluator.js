"use strict";

const acorn = require("acorn");

class JSEvaluator {
  constructor(options) {
    this.AST = null;
    this.options = {
      callExpressionOnly: false, // true: Evaluate function body only if it is called, false: evaluate function body always
      evalValue: false, // true: evaluate value, false: do not evaluate value.
      checkNativeParams: false, // true: check the count of arguments for the native function call
      ...options
    };
    this.mainFrame = null;
    this.Entry = {
      id: "symbolName",
      type: "object", // "object", "label", "function", "string", "number", "array", "block", "boolean", undefined
      value: null, // if type is function, value: { body: ..., params: ..., frame: ..., expression: ... }
      kind: "let", // "let", "var", "const", "frame", "argument", "reserved", "native", "property"
      loc: {
        start: {
          line: 0,
          column: 0
        },
        end: {
          line: 0,
          column: 0
        },
        pos: {
          start: 0,
          end: 0
        }
      }
    };
    this.errors = [];
    this.parseErrors = [];
    this.reserved = [];
  }

  getErrors() {
    return [...this.errors, ...this.parseErrors];
  }

  resetErrors() {
    this.errors.length = 0;
    this.parseErrors.length = 0;
  }

  pushError(entry) {
    var error = this.errors.find(element => {
      if (element.loc.start.line !== entry.loc.start.line) {
        return false;
      }

      if (element.loc.end.line !== entry.loc.end.line) {
        return false;
      }

      if (element.loc.start.column !== entry.loc.start.column) {
        return false;
      }

      if (element.loc.end.column !== entry.loc.end.column) {
        return false;
      }

      if (element.type !== entry.type) {
        return false;
      }

      return true;
    });

    if (!error) {
      this.errors.push(entry);
      return true;
    }

    return false;
  }

  addReserved(reserved) {
    this.reserved = [...this.reserved, reserved];
  }

  setListOfReserved(list) {
    this.reserved = [...list];
  }

  getListOfReserved() {
    return this.reserved;
  }

  getReserved(id) {
    let ret = this.reserved.find(reserved => reserved.id === id);

    if (ret === undefined) {
      return null;
    }

    return {
      id: "Returns of the " + id,
      ...ret,
      kind: "reserved"
    };
  }

  valueType(value) {
    if (value === undefined) {
      return undefined;
    }

    const type = typeof value;

    if (type === "object" && Array.isArray(value)) {
      return "array";
    }

    return type;
  }

  parse(code, isMerge) {
    this.parseErrors.length = 0;

    try {
      this.AST = acorn.parse(code, {
        ecmaVersion: 9, // 3, 5, 6 (2015), 7 (2016), 8 (2017), 9 (2018), 10 (2019, partial support)
        sourceType: "script", // "module"
        onInsertedSemicolon: null,
        onTrailingComma: null,
        allowReserved: true,
        allowReturnOutsideFunction: false,
        allowImportExportEverywhere: false,
        allowAwaitOutsideFunction: true,
        allowHashBang: false,
        locations: true,
        onToken: null,
        onComment: null,
        ranges: false,
        program: isMerge ? this.AST : null, // The AST if we have, a current AST would be merged into this.
        sourceFile: false,
        directSourceFile: false,
        preserveParens: false
      });
    } catch (e) {
      console.log(e);
      this.parseErrors.push({
        type: "error",
        message: e.name + ": " + e.message,
        pos: e.pos,
        loc: {
          start: {
            line: e.loc.line,
            column: e.loc.column
          },
          end: {
            line: e.loc.line,
            column: e.loc.column
          }
        }
      });
      return false;
    }

    if (this.AST.type !== "Program") {
      this.pushError({
        type: "error",
        message: "Internal error: The type of the root node is not the Program",
        loc: {
          start: {
            line: 1,
            column: 0
          },
          end: {
            line: 1,
            column: 0
          }
        }
      });
      this.AST = null;
      return false;
    }

    return true;
  }

  build() {
    this.mainFrame = null;
    this.errors.length = 0;

    try {
      var state = {
        frame: null,
        isActive: true
      };

      console.log("Build!! symbol table", this.AST);
      this.ConsumeNode(this.AST, null, "lvalue", state);
    } catch (error) {
      console.log(error);
      return false;
    }

    return true;
  }

  SymbolTable() {
    return this.mainFrame;
  }

  ConsumeNode(node, parent, vType, state) {
    if (!node) {
      console.log("Empty node");
      return {
        type: undefined,
        value: undefined,
        kind: undefined
      };
    }

    if (!node.type) {
      console.log("Invalid type");
      return {
        type: undefined,
        value: undefined,
        kind: undefined
      };
    }

    if (typeof this[node.type] !== "function") {
      console.log("Unsupported type: ", node.type, node);
      return {
        type: undefined,
        value: undefined,
        kind: undefined
      };
    }

    return this[node.type](node, parent, vType, state);
  }

  // Returns pushed index of an entry.
  Push(entry, state) {
    if (!state) {
      this.mainFrame.value.stack.push(entry);
    } else {
      state.frame.value.stack.push(entry);
    }
  }

  // loc === null: global search
  // table === null: global table
  // isStartWidth === false: matched symbol
  FindSymbol(name, loc, frame, isStartWith) {
    let i;

    if (!frame) {
      frame = this.mainFrame;
    }

    if (!frame || !frame.value.stack) {
      console.log("Symbol Table is empty");
      return null;
    }

    // Step 1. Find the target frame using given "loc" information
    let targetFrame = null;
    if (typeof loc === "undefined") {
      targetFrame = frame;
    } else {
      let frameList = [];
      let list = [frame];
      let iter;

      do {
        iter = list.pop();
        frameList.push(iter);

        for (i = 0; i < iter.value.stack.length; i++) {
          if (iter.value.stack[i].kind === "frame") {
            list.unshift(iter.value.stack[i]);
          }
        }
      } while (list.length > 0);

      let accuracy;
      for (i = 0; i < frameList.length; i++) {
        if (loc.pos) {
          if (
            frameList[i].loc.pos.start <= loc.pos.start &&
            loc.pos.end <= frameList[i].loc.pos.end
          ) {
            if (targetFrame === null) {
              targetFrame = frameList[i];
              accuracy =
                loc.pos.start -
                frameList[i].loc.pos.start +
                (frameList[i].loc.pos.end - loc.pos.end);
            } else {
              let tmp =
                loc.pos.start -
                frameList[i].loc.pos.start +
                (frameList[i].loc.pos.end - loc.pos.end);
              if (tmp < accuracy) {
                accuracy = tmp;
                targetFrame = frameList[i];
              }
            }
          }
        } else if (
          frameList[i].loc.start.line <= loc.start.line &&
          loc.end.line <= frameList[i].loc.end.line
        ) {
          if (targetFrame === null) {
            targetFrame = frameList[i];
            accuracy =
              loc.start.line -
              frameList[i].loc.start.line +
              (frameList[i].loc.end.line - loc.end.line);
          } else {
            let tmp =
              loc.start.line -
              frameList[i].loc.start.line +
              (frameList[i].loc.end.line - loc.end.line);
            if (tmp < accuracy) {
              accuracy = tmp;
              targetFrame = frameList[i];
            }
          }
        }
      }
    }

    let list = isStartWith === true ? [] : null;
    if (!targetFrame) {
      // @NOTE
      // Failed to find a symbol in a given location's frame.
      // Try to find it again using the given frame.
      targetFrame = frame;
      if (!targetFrame) {
        // Not found
        return list;
      }
    }

    let capturedList = [frame.value.parent];
    let searchedList = [];
    // Find the symbol from the targetFrame.
    do {
      searchedList.push(targetFrame);

      // Search in the local scope including arguments.
      for (i = 0; i < targetFrame.value.stack.length; i++) {
        if (targetFrame.value.stack[i].kind === "frame") {
          continue;
        }

        if (isStartWith === true) {
          if (
            this.valueType(targetFrame.value.stack[i].id) === "string" &&
            targetFrame.value.stack[i].id.startsWith(name) === true
          ) {
            list.push(targetFrame.value.stack[i]);
          }
        } else if (targetFrame.value.stack[i].id === name) {
          return targetFrame.value.stack[i];
        }
      }

      if (targetFrame.frame) {
        capturedList.push(targetFrame.frame);
      }

      targetFrame = targetFrame.value.parent;

      if (!targetFrame) {
        targetFrame = capturedList.pop();
      }

      while (
        targetFrame &&
        searchedList.find(element => element === targetFrame)
      ) {
        targetFrame = capturedList.pop();
      }
    } while (targetFrame);

    return list;
  }

  // handlers for nodes
  //
  VariableDeclarator(node, parent, vType, state) {
    const left = this.ConsumeNode(node.id, node, "rvalue", state);
    let kind;

    if (left.kind === "reserved") {
      this.pushError({
        type: "error",
        message: left.id + " is a reserved as the " + left.type,
        loc: Object.assign(
          { pos: { start: node.id.start, end: node.id.end } },
          node.id.loc
        )
      });

      return left;
    }

    if (left.type !== undefined) {
      if (left.isGlobal) {
        this.pushError({
          type: "info",
          message: "The " + left.id + " would be the shadow variable",
          loc: Object.assign(
            { pos: { start: node.id.start, end: node.id.end } },
            node.id.loc
          )
        });
      } else {
        this.pushError({
          type: "warning",
          message: left.id + " is already declared",
          loc: Object.assign(
            { pos: { start: node.id.start, end: node.id.end } },
            node.id.loc
          )
        });
      }

      // In this case, register this variable to the local scope
      kind = "let";
    } else {
      kind = parent.kind;
      if (kind === undefined) {
        console.log("Parent node has no kind field");
        kind = "var";
      }
    }

    // @NOTE:
    // node.init could be null.
    const value = this.ConsumeNode(node.init, node, "rvalue", state);
    // TODO: even if the init is null, value should be in the data structure.

    let ret = Object.assign({}, this.Entry, {
      id: left.id,
      type: value ? value.type : undefined, // FIXME: ternary operator does not required.
      value: value ? value.value : undefined,
      kind: kind,
      loc: Object.assign(
        {
          pos: {
            start: node.init ? node.init.start : node.start,
            end: node.init ? node.init.end : node.end
          }
        },
        node.init ? node.init.loc : node.loc
      )
    });

    if (kind === "var" && state.isActive === true) {
      // Push to the global scope
      this.Push(ret);
    } else {
      this.Push(ret, state);
    }

    return ret;
  }

  // Terminal node
  Identifier(node, parent, vType, state) {
    var entry;

    if (vType === "lvalue") {
      entry = {
        type: "identifier",
        value: node.name
      };
    } else {
      // Step 1. Find symbol in the given table first.
      entry = this.FindSymbol(node.name, node.loc, state.frame);
      if (!entry) {
        if (state.isActive === false) {
          // Step 2. If the given table is for local scope,
          //         try to search again in the global scope table.
          entry = this.FindSymbol(node.name);
          if (entry) {
            entry.isGlobal = true; // Mark as global variable
          }
        }

        if (!entry) {
          // Step 3. If the symbol is not found,
          //         try to find it from reserved table.
          entry = this.getReserved(node.name);
        }

        if (!entry) {
          entry = {
            id: node.name,
            type: undefined,
            value: undefined,
            kind: undefined
          };
        }
      }
    }

    return entry;
  }

  // Terminal node
  Literal(node, parent, vType, state) {
    return {
      type: this.valueType(node.value),
      value: node.value
    };
  }

  // hello = {
  //   test: "hi"
  // }
  ObjectExpression(node, parent, vType, state) {
    let value = {
      type: "object",
      value: {}
    };

    node.properties.forEach(property => {
      // property node is consisting with "key", "value"
      const eValue = this.ConsumeNode(property, node, "rvalue", state);
      value = {
        ...value,
        value: {
          ...value.value,
          ...eValue
        }
      };
    });

    return value;
  }

  // A child node of the ObjectExpression
  Property(node, parent, vType, state) {
    const left = this.ConsumeNode(
      node.key,
      node,
      node.computed ? "rvalue" : "lvalue",
      state
    );
    const right = this.ConsumeNode(node.value, node, "rvalue", state);

    if (left.type === undefined || left.type === "object") {
      if (this.options.evalValue === true || left.kind === undefined) {
        this.pushError({
          type: "warning",
          message: left.id + " is " + left.type + " (left)",
          loc: Object.assign(
            { pos: { start: node.key.start, end: node.key.end } },
            node.key.loc
          )
        });
      }
    }

    if (
      right.type === undefined &&
      (right.kind !== "argument" || state.isActive === true)
    ) {
      if (this.options.evalValue === true || right.kind === undefined) {
        this.pushError({
          type: "warning",
          message: right.id + " is " + right.type + " (right)",
          loc: Object.assign(
            {
              pos: {
                start: node.value ? node.value.start : node.start,
                end: node.value ? node.value.end : node.end
              }
            },
            node.value ? node.value.loc : node.loc
          )
        });
      }
    }

    const ret = {
      [left.value]: {
        id: left.value,
        ...right,
        kind: "property"
      }
    };

    return ret;
  }

  CallExpression(node, parent, vType, state) {
    let evalArgs = [];
    let returns = {
      id: "Returns of the function",
      type: undefined,
      value: undefined,
      kind: undefined
    };

    // arguments and callee can have the assignment or the declaration statements.
    let funcName = this.ConsumeNode(node.callee, node, "rvalue", state);
    if (!funcName) {
      console.log(
        "Unsupported function call found, please check the reserved function list and its return value",
        node.callee
      );
      return returns;
    }

    let paramIdx = 0;
    node.arguments.forEach(argument => {
      const pArg = this.ConsumeNode(argument, node, "rvalue", state);
      paramIdx++;
      if (
        pArg.type === undefined &&
        (pArg.kind !== "argument" || state.isActive === true)
      ) {
        if (this.options.evalValue === true || pArg.kind === undefined) {
          this.pushError({
            type: "warning",
            message:
              paramIdx + "th parameter (" + pArg.id + ") is undefined (call)",
            loc: Object.assign(
              { pos: { start: argument.start, end: argument.end } },
              argument.loc
            )
          });
        }
      }

      evalArgs.push(pArg); // ignore return value
    });

    if (funcName.kind === undefined) {
      this.pushError({
        type: "warning",
        message: funcName.id + " is not found in current scope",
        loc: Object.assign(
          { pos: { start: node.callee.start, end: node.callee.end } },
          node.callee.loc
        )
      });
    } else if (funcName.type === "function") {
      if (evalArgs.length !== funcName.value.params.length) {
        this.pushError({
          type: "warning",
          message:
            funcName.id +
            " requires " +
            (funcName.value.params ? funcName.value.params.length : 0) +
            " parameters",
          loc: Object.assign(
            { pos: { start: node.callee.start, end: node.callee.end } },
            node.callee.loc
          )
        });
      }

      if (funcName.kind === "reserved") {
        if (typeof funcName.value === "object") {
          // TODO:
          // validate funcName.value which was given by the user (developer)
          if (
            typeof funcName.value.type === "undefined" ||
            typeof funcName.value.value === "undefined"
          ) {
            console.log(
              "Reserved function has invalid return value",
              funcName.value
            );
          } else {
            returns = funcName.value;
          }
        } else {
          console.log("Reserved function has invalid type of value", funcName);
        }
      } else {
        if (funcName.kind === "native" && funcName.type !== "function") {
          returns = funcName;
        } else {
          let i;
          let args = [];
          for (i = 0; i < funcName.value.params.length; i++) {
            const pEntry = this.ConsumeNode(
              funcName.value.params[i],
              node,
              "rvalue",
              state
            );

            const pValue = evalArgs[i] ? evalArgs[i] : pEntry;

            let e = Object.assign({}, this.Entry, {
              id: pEntry.id,
              type: pValue.type,
              value: pValue.value,
              kind: "argument", // let, var, const, argument, frame, reserved
              loc: Object.assign(
                { pos: { start: node.start, end: node.end } },
                node.loc
              )
            });

            args.push(e);
          }

          // NOTE:
          // In order to prevent from mutation of the state, copy it
          let callState;

          if (funcName.value.expression === true) {
            callState = {
              ...state,
              frame: {
                ...state.frame,
                value: {
                  ...state.frame.value,
                  stack: [...state.frame.value.stack]
                }
              }
            };
            args.forEach(arg => this.Push(arg, callState));
          } else {
            if (state.frame !== funcName.value.frame) {
              callState = {
                ...state,
                capturedFrame: funcName.value.frame,
                args: args
              };
            } else {
              callState = {
                ...state,
                args: args
              };
            }
          }

          returns = this.ConsumeNode(
            funcName.value.body,
            node,
            vType,
            callState
          );
        }
      }
    } else {
      this.pushError({
        type: "error",
        message: funcName.id + " is not a function",
        loc: Object.assign(
          { pos: { start: node.start, end: node.end } },
          node.loc
        )
      });
    }

    return returns;
  }

  UnaryExpression(node, parent, vType, state) {
    const entry = this.ConsumeNode(node.argument, node, "rvalue", state);
    let ret = { ...entry };

    if (ret.type === "function") {
      this.pushError({
        type: "warning",
        message: "trying to unary operation on a function " + entry.id,
        loc: Object.assign(
          {
            pos: {
              start: node.argument ? node.argument.start : node.start,
              end: node.argument ? node.argument.end : node.end
            }
          },
          node.argument ? node.argument.loc : node.loc
        )
      });
    }

    switch (node.operator) {
      case "-":
        if (ret.type !== "function" && ret.type !== "number") {
          this.pushError({
            type: "warning",
            message:
              "trying to unary operation on a " + ret.type + " " + entry.id,
            loc: Object.assign(
              { pos: { start: node.start, end: node.end } },
              node.loc
            )
          });
        }
        ret.value = -ret.value;
        ret.type = this.valueType(ret.value);
        break;
      case "!":
        ret.value = !ret.value;
        ret.type = this.valueType(ret.value);
        break;
      case "~":
        ret.value = ~ret.value;
        ret.type = this.valueType(ret.value);
        break;
      case "+":
        ret.value = Number(ret.value);
        ret.type = this.valueType(ret.value);
        break;
      case "typeof":
        ret.value = ret.type;
        ret.type = "string";
        break;
      case "delete":
        ret.value = undefined;
        ret.type = undefined;
        break;
      default:
        console.log("Unsupported UnaryOperator", node.operator);
        ret.value = undefined;
        ret.type = undefined;
        break;
    }

    return ret;
  }

  BinaryExpression(node, parent, vType, state) {
    let value;
    const left = this.ConsumeNode(node.left, node, "rvalue", state);
    const right = this.ConsumeNode(node.right, node, "rvalue", state);

    if (!left || !right) {
      console.log(left, right, "Not yet prepared to evaluate code");
      return {
        type: undefined,
        value: undefined,
        kind: undefined
      };
    }

    if (
      left.type === undefined &&
      (left.kind !== "argument" || state.isActive === true)
    ) {
      if (this.options.evalValue === true || left.kind === undefined) {
        this.pushError({
          type: "warning",
          message: left.id + " is undefined (binary)",
          loc: Object.assign(
            { pos: { start: node.left.start, end: node.left.end } },
            node.left.loc
          )
        });
      }
    }

    if (
      right.type === undefined &&
      (right.kind !== "argument" || state.isActive === true)
    ) {
      if (this.options.evalValue === true || right.kind === undefined) {
        this.pushError({
          type: "warning",
          message: right.id + " is undefined (binary)",
          loc: Object.assign(
            { pos: { start: node.right.start, end: node.right.end } },
            node.right.loc
          )
        });
      }
    }

    switch (node.operator) {
      case "<":
        value = left.value < right.value;
        break;
      case ">":
        value = left.value > right.value;
        break;
      case "<=":
        value = left.value <= right.value;
        break;
      case ">=":
        value = left.value >= right.value;
        break;
      case "!=":
        value = left.value != right.value;
        break;
      case "!==":
        value = left.value !== right.value;
        break;
      case "==":
        value = left.value == right.value;
        break;
      case "===":
        value = left.value === right.value;
        break;
      case "+":
        value = left.value + right.value;
        break;
      case "/":
        if (
          (left.kind !== "argument" && left.type !== "number") ||
          (right.kind !== "argument" && right.type !== "number")
        ) {
          if (
            this.options.evalValue === true ||
            left.kind === undefined ||
            right.kind === undefined
          ) {
            this.pushError({
              type: "warning",
              message:
                "Trying to do a divide operation on the " +
                left.type +
                " | " +
                right.type,
              loc: Object.assign(
                { pos: { start: node.start, end: node.end } },
                node.loc
              )
            });
          }
        }
        value = left.value / right.value;
        break;
      case "-":
        if (
          (left.kind !== "argument" && left.type !== "number") ||
          (right.kind !== "argument" && right.type !== "number")
        ) {
          if (
            this.options.evalValue === true ||
            left.kind === undefined ||
            right.kind === undefined
          ) {
            this.pushError({
              type: "warning",
              message:
                "Trying to do a subtract operation on the " +
                left.type +
                " | " +
                right.type,
              loc: Object.assign(
                { pos: { start: node.start, end: node.end } },
                node.loc
              )
            });
          }
        }
        value = left.value - right.value;
        break;
      case "*":
        if (
          (left.kind !== "argument" && left.type !== "number") ||
          (right.kind !== "argument" && right.type !== "number")
        ) {
          if (
            this.options.evalValue === true ||
            left.kind === undefined ||
            right.kind === undefined
          ) {
            this.pushError({
              type: "warning",
              message:
                "Trying to do a multiply operation on the " +
                left.type +
                " | " +
                right.type,
              loc: Object.assign(
                { pos: { start: node.start, end: node.end } },
                node.loc
              )
            });
          }
        }
        value = left.value * right.value;
        break;
      default:
        console.log("Unsupported binary expression", node.operator);
        value = undefined;
        break;
    }

    return {
      type: this.valueType(value),
      value: value,
      kind: "let"
    };
  }

  ArrayExpression(node, parent, vType, state) {
    var ret = [];

    node.elements.forEach(element => {
      ret.push(this.ConsumeNode(element, node, "rvalue", state));
    });

    return {
      type: "array",
      value: ret,
      kind: "let"
    };
  }

  // var func = function() {}
  FunctionExpression(node, parent, vType, state) {
    if (!this.options || !this.options.callExpressionOnly) {
      var localState = {
        frame: Object.assign({}, this.Entry, {
          id: "local",
          type: "block",
          value: {
            parent: state.frame,
            stack: []
          },
          kind: "frame",
          frame: state.frame,
          loc: Object.assign(
            { pos: { start: node.start, end: node.end } },
            node.loc
          )
        }),
        isActive: false
      };

      if (node.expression === true) {
        node.params.forEach(param => {
          const pEntry = this.ConsumeNode(param, node, "rvalue", localState);

          let entry = Object.assign({}, this.Entry, {
            id: pEntry.id,
            type: pEntry.type,
            value: pEntry.value,
            kind: "argument",
            loc: Object.assign(
              { pos: { start: param.start, end: param.end } },
              param.loc
            )
          });

          this.Push(entry, localState);
        });
      } else {
        localState.args = [];
        node.params.forEach(param => {
          const pEntry = this.ConsumeNode(param, node, "rvalue", localState);

          let entry = Object.assign({}, this.Entry, {
            id: pEntry.id,
            type: pEntry.type,
            value: pEntry.value,
            kind: "argument",
            loc: Object.assign(
              { pos: { start: param.start, end: param.end } },
              param.loc
            )
          });

          localState.args.push(entry);
        });
      }
      this.ConsumeNode(node.body, node, vType, localState);
      console.log("localTable", localState, "globalTable", state);
    }

    return {
      type: "function",
      value: {
        params: [...node.params],
        body: node.body,
        frame: state.frame,
        expression: node.expression
      },
      kind: "let"
    };
  }

  ArrowFunctionExpression(node, parent, vType, state) {
    if (!this.options || !this.options.callExpressionOnly) {
      var localState = {
        frame: Object.assign({}, this.Entry, {
          id: "local",
          type: "block",
          value: {
            parent: state.frame,
            stack: []
          },
          kind: "frame",
          frame: state.frame,
          loc: Object.assign(
            { pos: { start: node.start, end: node.end } },
            node.loc
          )
        }),
        isActive: false
      };

      if (node.expression === true) {
        node.params.forEach(param => {
          const pEntry = this.ConsumeNode(param, node, "rvalue", localState);

          let entry = Object.assign({}, this.Entry, {
            id: pEntry.id,
            type: pEntry.type,
            value: pEntry.value,
            kind: "argument",
            loc: Object.assign(
              { pos: { start: param.start, end: param.end } },
              param.loc
            )
          });

          this.Push(entry, localState);
        });
      } else {
        localState.args = [];
        node.params.forEach(param => {
          const pEntry = this.ConsumeNode(param, node, "rvalue", localState);

          let entry = Object.assign({}, this.Entry, {
            id: pEntry.id,
            type: pEntry.type,
            value: pEntry.value,
            kind: "argument",
            loc: Object.assign(
              { pos: { start: param.start, end: param.end } },
              param.loc
            )
          });

          localState.args.push(entry);
        });
      }

      this.ConsumeNode(node.body, node, vType, localState);
      console.log("localTable", localState, "globalTable", state);
    }

    return {
      type: "function",
      value: {
        params: [...node.params],
        body: node.body,
        frame: state.frame,
        expression: node.expression
      },
      kind: "let"
    };
  }

  FunctionDeclaration(node, parent, vType, state) {
    const funcName = this.ConsumeNode(node.id, parent, "rvalue", state);

    if (funcName.kind === "reserved") {
      this.pushError({
        type: "warning",
        message: funcName.id + " is reserved as a " + funcName.type,
        loc: Object.assign(
          { pos: { start: node.id.start, end: node.id.end } },
          node.id.loc
        )
      });

      return;
    }

    let kind = "var";
    if (funcName.kind !== undefined) {
      this.pushError({
        type: "warning",
        message: funcName.id + " is already declared as " + funcName.type,
        loc: Object.assign(
          { pos: { start: node.id.start, end: node.id.end } },
          node.id.loc
        )
      });
      kind = "let";
    }

    // CHECKME:
    // If the function was declared in a local scope, does it has to be registered as a local variable?
    // or add it to as a global variable?
    let entry = Object.assign({}, this.Entry, {
      id: funcName.id,
      type: "function",
      value: {
        params: [...node.params],
        body: node.body,
        frame: this.mainFrame,
        expression: node.expression
      },
      kind: kind,
      loc: Object.assign(
        { pos: { start: node.id.start, end: node.id.end } },
        node.id.loc
      )
    });
    this.Push(entry, state);

    if (!this.options || !this.options.callExpressionOnly) {
      // Evaluate body of the function
      var localState = {
        frame: Object.assign({}, this.Entry, {
          id: "local",
          type: "block",
          value: {
            parent: null,
            stack: []
          },
          kind: "frame",
          frame: this.mainFrame,
          loc: Object.assign(
            { pos: { start: node.start, end: node.end } },
            node.loc
          )
        }),
        isActive: false
      };

      localState.args = [];
      node.params.forEach(param => {
        const pEntry = this.ConsumeNode(param, node, "rvalue", localState);

        entry = Object.assign({}, this.Entry, {
          id: pEntry.id,
          type: pEntry.type,
          value: pEntry.value,
          kind: "argument",
          loc: Object.assign(
            { pos: { start: param.start, end: param.end } },
            param.loc
          )
        });

        localState.args.push(entry);
      });

      this.ConsumeNode(node.body, node, vType, localState);
      console.log("localTable", localState, "globalTable", state);
    }
  }

  ConditionalExpression(node, parent, vType, state) {
    const ret = this.ConsumeNode(node.test, node, "rvalue", state);
    const t = this.ConsumeNode(node.consequent, node, "rvalue", state);
    const f = this.ConsumeNode(node.alternate, node, "rvalue", state);

    return ret.value ? t : f;
  }

  // code: hello.text = "hi"
  MemberExpression(node, parent, vType, state) {
    const obj = this.ConsumeNode(node.object, node, "rvalue", state);
    const prop = this.ConsumeNode(
      node.property,
      node,
      node.computed ? "rvalue" : "lvalue",
      state
    );

    if (!obj) {
      console.log("Please check the reserved object list", node.object);
      return {
        id: undefined,
        type: undefined,
        value: undefined,
        kind: undefined
      };
    }

    if (
      obj.type === undefined &&
      (obj.kind !== "argument" || state.isActive === true)
    ) {
      this.pushError({
        type: "error",
        message: "cannot access " + prop.id + " of undefined",
        loc: Object.assign(
          { pos: { start: node.object.start, end: node.object.end } },
          node.object.loc
        )
      });

      return obj;
    }

    if (obj.value === null || obj.value === undefined) {
      if (obj.kind === "reserved") {
        if (obj.type !== "object") {
          this.erros.push({
            type: "warning",
            message: "trying to change the property of a reserved " + obj.type,
            loc: Object.assign(
              { pos: { start: node.object.start, end: node.object.end } },
              node.object.loc
            )
          });
        }
      }

      obj.type = "object";
      obj.value = {
        [prop.value]: {
          id: prop.value,
          type: undefined,
          value: undefined,
          kind: "property"
        }
      };
    }

    if (prop.value === undefined) {
      if (this.options.evalValue === true || prop.kind === undefined) {
        this.pushError({
          type: "error",
          message:
            "property on the " + obj.id + "(" + obj.type + ") is undefined",
          loc: Object.assign(
            { pos: { start: node.property.start, end: node.property.end } },
            node.property.loc
          )
        });

        return {
          id: undefined,
          type: undefined,
          value: undefined,
          kind: undefined
        };
      }
    }

    if (typeof obj.value[prop.value] === "undefined") {
      if (obj.type === "function") {
        switch (prop.value) {
          case "length":
            return {
              type: "number",
              value: obj.value.params ? obj.value.params.length : 0,
              kind: "native"
            };
          case "name":
            return {
              type: "string",
              value: obj.id,
              kind: "native"
            };
          default:
            this.errors.push({
              type: "error",
              message:
                "cannot create property " + prop.id + " on the " + obj.type,
              loc: Object.assign({}, node.object.loc)
            });

            return obj;
        }
      } else if (obj.type !== "object" && obj.type !== "array") {
        this.pushError({
          type: "error",
          message: "cannot create property " + prop.id + " on the " + obj.type,
          loc: Object.assign(
            { pos: { start: node.object.start, end: node.object.end } },
            node.object.loc
          )
        });

        return obj;
      }

      obj.value[prop.value] = {
        id: prop.value,
        type: undefined,
        value: undefined,
        kind: "property"
      };
    } else if (typeof obj.value[prop.value] === "function") {
      return {
        id: prop.value,
        type: "function",
        value: {
          params: new Array(obj.value[prop.value].length), // Create an parameter array of a native function
          body: {
            id: {
              type: "Identifier",
              name: prop.value
            },
            type: "_NativeFunctionCall",
            value: obj,
            computed: false,
            loc: { ...node.loc },
            start: node.start,
            end: node.end
          }, // TODO: Return value of a function
          frame: undefined,
          expression: undefined
        },
        kind: "native"
      };
    } else if (obj.type !== "object") {
      return {
        id: prop.value,
        type: this.valueType(obj.value[prop.value]),
        value: obj.value[prop.value],
        kind: "native"
      };
    } else if (!obj.value[prop.value]) {
      return {
        id: prop.value,
        type: undefined,
        value: undefined,
        kind: undefined
      };
    }

    return obj.value[prop.value];
  }

  BreakStatement(node, parent, vType, state) {
    const label = this.ConsumeNode(node.label, node, "rvalue", state);
    if (label.type === undefined) {
      return;
    }

    if (label.type !== "label") {
      this.pushError({
        type: "error",
        message: "label " + label.id + " is not found",
        loc: Object.assign(
          { pos: { start: node.label.start, end: node.label.end } },
          node.label.loc
        )
      });
    } else {
      this.ConsumeNode(label.value, node, vType, state);
    }
  }

  ContinueStatement(node, parent, vType, state) {
    const label = this.ConsumeNode(node.label, node, "rvalue", state);
    if (label.type === undefined) {
      return;
    }

    if (label.type !== "label") {
      this.pushError({
        type: "error",
        message: "label " + label.id + " is not found",
        loc: Object.assign(
          { pos: { start: node.label.start, end: node.label.end } },
          node.label.loc
        )
      });
    } else {
      this.ConsumeNode(label.value, node, vType, state);
    }
  }

  LabeledStatement(node, parent, vType, state) {
    const label = this.ConsumeNode(node.label, node, vType, state);

    const entry = Object.assign({}, this.Entry, {
      id: label.id,
      type: "label",
      value: node.body,
      kind: "let",
      loc: Object.assign(
        { pos: { start: node.start, end: node.end } },
        node.loc
      )
    });
    this.Push(entry, state);

    this.ConsumeNode(node.body, node, vType, state);
  }

  ReturnStatement(node, parent, vType, state) {
    return this.ConsumeNode(node.argument, node, vType, state);
  }

  ExpressionStatement(node, parent, vType, state) {
    return this.ConsumeNode(node.expression, node, vType, state);
  }

  AwaitExpression(node, parent, vType, state) {
    return this.ConsumeNode(node.argument, node, vType, state);
  }

  AssignmentExpression(node, parent, vType, state) {
    let left = this.ConsumeNode(node.left, node, "rvalue", state);
    const right = this.ConsumeNode(node.right, node, "rvalue", state);

    if (!left || !right) {
      console.log(left, right, "Not yet prepared to evaluate code");
      return {
        type: undefined,
        value: undefined,
        kind: undefined
      };
    }

    if (
      right.type === undefined &&
      (right.kind !== "argument" || state.isActive === true)
    ) {
      if (this.options.evalValue === true || right.kind === undefined) {
        this.pushError({
          type: "warning",
          message: right.id + " is undefined (assign)",
          loc: Object.assign(
            { pos: { start: node.right.start, end: node.right.end } },
            node.right.loc
          )
        });
      }
    }

    if (left.kind === "reserved") {
      if (left.type === "function") {
        this.pushError({
          type: "error",
          message: "Cannot assign a value to the reserved function " + left.id,
          loc: Object.assign(
            { pos: { start: node.left.start, end: node.left.end } },
            node.left.loc
          )
        });

        return left;
      }
    } else if (left.kind === undefined) {
      // NOTE
      // Create a new variable
      left = Object.assign({}, this.Entry, {
        id: left.id,
        type: right.type,
        value: right.value,
        kind: "var", // let, var, const
        loc: Object.assign(
          { pos: { start: node.left.start, end: node.left.end } },
          node.left.loc
        )
      });

      if (state.isActive === true) {
        // Push to the global table.
        this.Push(left);
      } else {
        this.Push(left, state);
      }
    } else if (left.kind === "const") {
      this.pushError({
        type: "error",
        message: "Cannot change the constant " + left.id,
        loc: Object.assign(
          { pos: { start: node.left.start, end: node.left.end } },
          node.left.loc
        )
      });

      return left;
    }

    switch (node.operator) {
      case "=":
        left.value = right.value;
        left.type = right.type;
        break;
      case "+=":
        left.value += right.value;
        left.type = this.valueType(left.value);
        break;
      case "-=":
        if (right.type !== "number" || left.type !== "number") {
          this.pushError({
            type: "warning",
            message:
              "Trying to do a " +
              node.operator +
              " operation on the " +
              right.type +
              "/" +
              left.type,
            loc: Object.assign(
              { pos: { start: node.start, end: node.end } },
              node.loc
            )
          });
        }
        left.value -= right.value;
        left.type = this.valueType(left.value);
        break;
      case "*=":
        if (right.type !== "number" || left.type !== "number") {
          this.pushError({
            type: "warning",
            message:
              "Trying to do a " +
              node.operator +
              " operation on the " +
              right.type +
              "/" +
              left.type,
            loc: Object.assign(
              { pos: { start: node.start, end: node.end } },
              node.loc
            )
          });
        }
        left.value *= right.value;
        left.type = this.valueType(left.value);
        break;
      case "/=":
        if (right.type !== "number" || left.type !== "number") {
          this.pushError({
            type: "warning",
            message:
              "Trying to do a " +
              node.operator +
              " operation on the " +
              right.type +
              "/" +
              left.type,
            loc: Object.assign(
              { pos: { start: node.start, end: node.end } },
              node.loc
            )
          });
        }

        left.value /= right.value;
        left.type = this.valueType(left.value);
        break;
      default:
        console.log("Unsupported assignment operator", node.operator);
    }

    return left;
  }

  DoWhileStatement(node, parent, vType, state) {
    this.ConsumeNode(node.test, node, "rvalue", state);
    this.ConsumeNode(node.body, node, vType, state);
  }

  WhileStatement(node, parent, vType, state) {
    this.ConsumeNode(node.test, node, "rvalue", state);
    this.ConsumeNode(node.body, node, vType, state);
  }

  UpdateExpression(node, parent, vType, state) {
    let v;

    v = this.ConsumeNode(node.argument, node, "rvalue", state);
    if (
      v.type === undefined &&
      (v.kind !== "argument" || state.isActive === true)
    ) {
      if (this.options.evalValue === true || v.kind === undefined) {
        this.pushError({
          type: "warning",
          message: v.id + " is undefined (update)",
          loc: Object.assign(
            { pos: { start: node.start, end: node.end } },
            node.loc
          )
        });
      }
    }

    switch (node.operator) {
      case "++":
        if (
          v.type !== "number" &&
          (v.kind !== "argument" || state.isActive === true)
        ) {
          if (this.options.evalValue === true || v.kind === undefined) {
            this.pushError({
              type: "info",
              message: v.id + " is not a number type",
              loc: Object.assign(
                { pos: { start: node.start, end: node.end } },
                node.loc
              )
            });
          }
        }
        v.value++;
        break;
      case "--":
        if (
          v.type !== "number" &&
          (v.kind !== "argument" || state.isActive === true)
        ) {
          if (this.options.evalValue === true || v.kind === undefined) {
            this.pushError({
              type: "info",
              message: v.id + " is not a number type",
              loc: Object.assign(
                { pos: { start: node.start, end: node.end } },
                node.loc
              )
            });
          }
        }
        v.value--;
        break;
      default:
        console.log("Unsupported update operator", node.operator);
        v = {
          type: undefined,
          value: undefined
        };
        break;
    }

    return v;
  }

  ForStatement(node, parent, vType, state) {
    this.ConsumeNode(node.init, node, "rvalue", state);
    const test = this.ConsumeNode(node.test, node, "rvalue", state);
    this.ConsumeNode(node.update, node, "rvalue", state);
    this.ConsumeNode(node.body, node, vType, state);

    if (node.test && test.type !== "boolean") {
      if (this.options.evalValue === true || test.kind === undefined) {
        this.pushError({
          type: "info",
          message: test.value + " is not a boolean type",
          loc: Object.assign(
            { pos: { start: node.test.start, end: node.test.end } },
            node.test.loc
          )
        });
      }
    }
  }

  BlockStatement(node, parent, vType, state) {
    let entry = Object.assign({}, this.Entry, {
      id: null,
      type: "block",
      value: {
        parent: state.frame,
        stack: []
      },
      kind: "frame",
      frame: state.capturedFrame,
      loc: Object.assign(
        { pos: { start: node.start, end: node.end } },
        node.loc
      )
    });

    this.Push(entry, state);

    let frame = state.frame;
    state.frame = entry;

    if (Array.isArray(state.args)) {
      let arg;
      // Push the arguments to the current stack frame.
      while (!!(arg = state.args.shift())) {
        this.Push(arg, state);
      }

      delete state.args;
    }

    let list = [
      {
        id: "Result of the function call",
        type: undefined,
        value: undefined
      }
    ];

    // NOTE:
    // processing the FunctionDeclaration first
    node.body.forEach(statement => {
      if (statement.type === "FunctionDeclaration") {
        const ret = this.ConsumeNode(statement, node, vType, state);
        if (statement.type === "ReturnStatement") {
          list.unshift(ret);
        }
      }
    });

    // NOTE:
    // and then handling the rest of statements.
    node.body.forEach(statement => {
      if (statement.type !== "FunctionDeclaration") {
        const ret = this.ConsumeNode(statement, node, vType, state);
        if (statement.type === "ReturnStatement") {
          list.unshift(ret);
        }
      }
    });

    state.frame = frame;

    return list[0];
  }

  IfStatement(node, parent, vType, state) {
    this.ConsumeNode(node.test, node, vType, state);
    this.ConsumeNode(node.consequent, node, vType, state);
    this.ConsumeNode(node.alternate, node, vType, state);
  }

  SwitchStatement(node, parent, vType, state) {
    this.ConsumeNode(node.discriminant, node, vType, state);
    node.cases.forEach(statement =>
      this.ConsumeNode(statement, node, vType, state)
    );
  }

  SwitchCase(node, parent, vType, state) {
    this.ConsumeNode(node.test, node, vType, state);
    node.consequent.forEach(statement =>
      this.ConsumeNode(statement, node, vType, state)
    );
  }

  Program(node, parent, vType, state) {
    this.mainFrame = state.frame = Object.assign({}, this.Entry, {
      id: "main",
      type: "block",
      value: {
        parent: null,
        stack: []
      },
      kind: "frame",
      frame: undefined,
      loc: Object.assign(
        { pos: { start: node.start, end: node.end } },
        node.loc
      )
    });

    // NOTE:
    // processing the FunctionDeclaration first
    node.body.forEach(statement => {
      if (statement.type === "FunctionDeclaration") {
        this.ConsumeNode(statement, node, "lvalue", state);
      }
    });

    // NOTE:
    // and then handling the rest of statements.
    node.body.forEach(statement => {
      if (statement.type !== "FunctionDeclaration") {
        this.ConsumeNode(statement, node, "lvalue", state);
      }
    });
  }

  VariableDeclaration(node, parent, vType, state) {
    node.declarations.forEach(declaration =>
      this.ConsumeNode(declaration, node, "lvalue", state)
    );
  }

  // NOTE:
  _NativeFunctionCall(node, parent, vType, state) {
    // Extract property name
    let id = this.ConsumeNode(
      node.id,
      node,
      node.computed === false ? "lvalue" : "rvalue",
      state
    );
    let args;

    // Converting arguments
    if (state.args) {
      args = state.args.map(arg => this.toNativeValue(arg, node, vType, state));
    }

    let nativeObject = this.toNativeValue(node.value, node, vType, state);
    let ret = nativeObject[id.value].apply(nativeObject, args);
    node.value = this.fromNativeValue(nativeObject);

    return this.fromNativeValue(ret);
  }

  // NOTE:
  // The "state" for the conversion of the "function".
  toNativeValue(arg, node, vType, state) {
    let ret;

    if (!arg) {
      console.error("arg is undefined");
      return undefined;
    }

    if (arg.type === "object") {
      let value = arg.value;

      ret = {};

      Object.keys(value).forEach(k => {
        ret[k] = this.toNativeValue(value[k], node, vType, state);
      });
    } else if (arg.type === "array") {
      ret = arg.value.map(v => this.toNativeValue(v));
    } else if (arg.type === "function") {
      // WARN:
      // () => {}, The arrow function does not have the "arguments" object.
      let retFunc = function() {
        let ret;

        if (
          this.options.checkNativeParams &&
          arguments.length !== arg.value.params.length
        ) {
          this.pushError({
            type: "warning",
            message:
              "function requires " +
              arg.value.params.length +
              " but given " +
              arguments.length +
              " (callback call)",
            loc: Object.assign({}, arg.loc)
          });
        }

        if (!arg.value.body) {
          this.pushError({
            type: "error",
            message: "callback function does not defined",
            loc: Object.assign({}, arg.loc)
          });
        } else {
          if (arg.value.expression === true) {
            let localState = {
              ...state,
              frame: {
                ...state.frame,
                value: {
                  ...state.frame.value,
                  stack: [...state.frame.value.stack]
                }
              }
            };
            let i;

            for (i = 0; i < arg.value.params.length; i++) {
              const pEntry = this.ConsumeNode(
                arg.value.params[i],
                node,
                "rvalue",
                state
              );

              let e = Object.assign({}, this.Entry, {
                ...this.fromNativeValue(arguments[i]),
                id: pEntry.id,
                kind: "argument", // let, var, const, argument, frame, reserved
                loc: Object.assign({}, arg.loc)
              });

              this.Push(e, localState);
            }

            console.log("(expression) Argument localState", i, localState);

            ret = this.ConsumeNode(arg.value.body, node, vType, localState);
          } else {
            let localState = { ...state };
            let i;

            localState.args = [];

            for (i = 0; i < arg.value.params.length; i++) {
              const pEntry = this.ConsumeNode(
                arg.value.params[i],
                node,
                "rvalue",
                state
              );

              let e = Object.assign({}, this.Entry, {
                ...this.fromNativeValue(arguments[i]),
                id: pEntry.id,
                kind: "argument", // let, var, const, argument, frame, reserved
                loc: Object.assign({}, arg.loc)
              });

              localState.args.push(e);
            }

            console.log("Argument localState", i, localState);

            ret = this.ConsumeNode(arg.value.body, node, vType, localState);
          }

          return this.toNativeValue(ret, node, vType, state);
        }
      };

      ret = retFunc.bind(this);
    } else {
      ret = arg.value;
    }

    return ret;
  }

  // Convert the native value to the JSEvaluator value
  fromNativeValue(arg, key, kind) {
    let type = this.valueType(arg);
    let value = arg;

    if (type === "object") {
      value = {};
      Object.keys(arg).forEach(
        k => (value[k] = this.fromNativeValue(arg[k], k, "property"))
      );
    } else if (type === "array") {
      value = arg.map(a => this.fromNativeValue(a));
    }

    return {
      id: key,
      type: type,
      value: value,
      kind: kind
    };
  }

  // TODO:
  // Following methods are not implemented node handlers.
  //
  ParenthesizedExpression(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  ClassDeclaration(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  ClassExpression(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  SequenceExpression(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  LogicalExpression(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  TaggedTemplateExpression(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  ThisExpression(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  NewExpression(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  ObjectPattern(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  YieldExpression(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  DebuggerStatement(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  ThrowStatement(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  TryStatement(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  WithStatement(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  EmptyStatement(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  ForInStatement(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }

  ForOfStatement(node, parent, vType, state) {
    console.log("Not implemented", node);
    return {
      type: undefined,
      value: undefined,
      kind: undefined
    };
  }
}

module.exports = JSEvaluator;
