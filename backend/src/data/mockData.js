/**
 * Mock user profiles used to populate the AI's context.
 * In production these would be fetched from your database / auth token.
 */
export const mockUsers = {
  "user-1001": {
    userId: "user-1001",
    subscriptionState: "subscribed",
    healthGoals: ["stress management", "better sleep", "mindfulness"],
    currentFocus: "stress & sleep",
  },
  "user-1002": {
    userId: "user-1002",
    subscriptionState: "trial",
    healthGoals: ["fitness", "nutrition", "energy"],
    currentFocus: "building a morning routine",
  },
};

/**
 * Returns the profile for the given userId.
 * Falls back to user-1001 when the id is not found.
 */
export function getUserContext(userId) {
  return mockUsers[userId] ?? mockUsers["user-1001"];
}
