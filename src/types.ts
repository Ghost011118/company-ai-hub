export type Role = "ADMIN" | "MEMBER";
export type CapabilityType = "AGENT" | "SKILL" | "PROMPT";
export type CapabilityScope = "COMPANY" | "PERSONAL";
export type SubmissionStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

export interface AuthenticatedUser extends PublicUser {
  sessionId: string;
  csrfHash: string;
}

export interface CapabilitySnapshot {
  type: CapabilityType;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  priority: number;
  enabled: boolean;
  alwaysOn: boolean;
  skillIds: string[];
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedUser;
    }
  }
}
