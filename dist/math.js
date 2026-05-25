"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.average = average;
exports.stdDev = stdDev;
exports.coefficientOfVariation = coefficientOfVariation;
exports.linearTrend = linearTrend;
exports.pearsonCorrelation = pearsonCorrelation;
function average(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function stdDev(arr) {
    const avg = average(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length);
}
function coefficientOfVariation(arr) {
    const avg = average(arr);
    return avg > 0 ? stdDev(arr) / avg : 0;
}
function linearTrend(arr) {
    const n = arr.length;
    if (n < 3)
        return 0;
    const xMean = (n - 1) / 2;
    const yMean = average(arr);
    const num = arr.reduce((s, y, x) => s + (x - xMean) * (y - yMean), 0);
    const den = arr.reduce((s, _, x) => s + (x - xMean) ** 2, 0);
    const slope = den !== 0 ? num / den : 0;
    return slope / (yMean || 1);
}
function pearsonCorrelation(arr) {
    const n = arr.length;
    if (n < 3)
        return 0;
    const xMean = (n - 1) / 2;
    const yMean = average(arr);
    const num = arr.reduce((s, y, x) => s + (x - xMean) * (y - yMean), 0);
    const denX = Math.sqrt(arr.reduce((s, _, x) => s + (x - xMean) ** 2, 0));
    const denY = Math.sqrt(arr.reduce((s, y) => s + (y - yMean) ** 2, 0));
    return denX > 0 && denY > 0 ? num / (denX * denY) : 0;
}
