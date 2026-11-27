import { createContext } from "react";

export const ConversionInput = createContext<{ text: string; preferredLabel: string } | undefined>(undefined);
