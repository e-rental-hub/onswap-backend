import winston from "winston";
// import { Sentry, isSentryEnabled } from "../config/sentryConnection";
// import { sendDiscordNotification } from "../utils/discord";

// Winston logger for local logs
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message, stack }) =>
      `${timestamp} [${level.toUpperCase()}] ${message} ${stack || ""}`
    )
  ),
  transports: [new winston.transports.Console()],
});

// Expose logger for testing/mocking
export const __getLogger = () => logger;

// Wrapper functions
const logDebug = (message: string, context?: Record<string, any>) => {
  logger.debug(message, context);
  // sendDiscordNotification("💡 Debug Logged", message, "debug");
};

const logInfo = (message: string, context?: Record<string, any>) => {
  logger.info(message, context);
  // sendDiscordNotification("💡 Info Logged", message, "info");
};

const logWarn = (message: string, context?: Record<string, any>) => {
  logger.warn(message, context);
  // if (isSentryEnabled) {
  //   // Convert warning to a message with level "warning"
  //   Sentry.captureMessage(message, "warning");
  // }
  // sendDiscordNotification("⚠️ Warning Logged", message, "warning");
};

const logError = (error: Error | string, context?: Record<string, any>) => {
  const message = typeof error === "string" ? error : error.message;

  logger.error(message, context);
  
  // if (isSentryEnabled) {
  //   if (typeof error === "string") {
  //     Sentry.captureMessage(error, "error");
  //   } else {
  //     Sentry.captureException(error);
  //   }
  // }
  // sendDiscordNotification("❌ Error Logged", message, "error");
};

export { logDebug, logInfo, logWarn, logError, logger };