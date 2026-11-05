// 计算器工具：基础运算函数（REQ-001「为 calc.js 添加基础运算函数」的 PoC fixture 工作目录）
function add(a, b) {
  return a + b;
}

// 乘法函数：返回两个数的乘积
function multiply(a, b) {
  return a * b;
}

// 除法函数：b 为 0 时抛出异常
function divide(a, b) {
  if (b === 0) throw new Error('divide by zero');
  return a / b;
}

module.exports = { add, multiply, divide };

// 自测断言：divide(4,0) 必须抛出 Error
let threw = false;
try { divide(4, 0); } catch (e) { threw = e instanceof Error; }
if (!threw) throw new Error('bad');

// 自测断言：multiply(3,4) 必须等于 12
if (multiply(3, 4) !== 12) throw new Error('bad multiply');
