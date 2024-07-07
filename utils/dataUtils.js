function convertMillisecondsToSeconds(milliseconds) {
  // Convert milliseconds to seconds
  const seconds = milliseconds / 1000;

  // Return the result, optionally rounding it to a certain number of decimal places
  return seconds;
}

const isEmail = potentialEmail => {
  const re =
    /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return re.test(String(potentialEmail).toLowerCase());
};

export { convertMillisecondsToSeconds, isEmail };
