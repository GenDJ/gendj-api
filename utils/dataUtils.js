function convertMillisecondsToMinutes(milliseconds) {
  // Convert milliseconds to minutes
  const minutes = milliseconds / 1000 / 60;

  // Return the result, optionally rounding it to a certain number of decimal places
  return minutes;
}

const isEmail = potentialEmail => {
  const re =
    /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return re.test(String(potentialEmail).toLowerCase());
};

export { convertMillisecondsToMinutes, isEmail };
