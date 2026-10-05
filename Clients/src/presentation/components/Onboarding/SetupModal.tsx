/**
 * SetupModal - A simple modal shown to the org creator on their first login
 *
 * This modal offers:
 * - Add demo data (helpful for navigation)
 * - Start with a blank dashboard
 * - Optionally add an LLM API key (deep-links to the key form)
 *
 * The modal is only shown when:
 * 1. User is the org creator (first admin)
 * 2. Organization onboarding_status is 'pending'
 * 3. User is on the dashboard route
 */

import React, { useState } from "react";
import { Box, Stack, Typography, CircularProgress } from "@mui/material";
import { Database, Key, LayoutDashboard } from "lucide-react";
import { useDispatch } from "react-redux";
import { CustomizableButton } from "../button/customizable-button";
import { postAutoDrivers } from "../../../application/repository/entity.repository";
import { updateOnboardingStatus } from "../../../application/repository/organization.repository";
import { useAuth } from "../../../application/hooks/useAuth";
import { LLM_KEY_CREATE_PATH } from "../../../application/constants/llmKeyDeepLink";
import { setOnboardingStatus } from "../../../application/redux/auth/authSlice";
import { brand, status, text, background, border } from "../../themes/palette";
import { fontSize, fontWeight } from "../../themes/typography";

export interface SetupCompleteOptions {
  /** When set, App navigates here instead of Start here. */
  destination?: string;
}

interface SetupModalProps {
  /** Callback when setup is complete (either option selected) */
  onComplete: (options?: SetupCompleteOptions) => void;
  /** Callback when user skips/dismisses (treated as "start blank") */
  onSkip: () => void;
}

const SetupModal: React.FC<SetupModalProps> = ({ onComplete, onSkip }) => {
  const { organizationId } = useAuth();
  const dispatch = useDispatch();
  const [isLoading, setIsLoading] = useState(false);
  const [loadingOption, setLoadingOption] = useState<"demo" | "blank" | "key" | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = async () => {
    if (isLoading) return;

    setIsLoading(true);
    setLoadingOption("blank");

    try {
      // Update onboarding status to completed (skip = start blank)
      if (organizationId) {
        await updateOnboardingStatus(organizationId);
      }

      // Update Redux state so it persists after reload
      dispatch(setOnboardingStatus("completed"));

      setIsClosing(true);
      setTimeout(() => {
        onSkip();
      }, 300);
    } catch (error) {
      console.error("Error completing setup:", error);
      setIsLoading(false);
      setLoadingOption(null);
    }
  };

  const handleSelectDemo = async () => {
    if (isLoading) return;

    setIsLoading(true);
    setLoadingOption("demo");

    try {
      // Insert demo data
      await postAutoDrivers();

      // Update onboarding status to completed
      if (organizationId) {
        await updateOnboardingStatus(organizationId);
      }

      // Update Redux state so it persists after reload
      dispatch(setOnboardingStatus("completed"));

      setIsClosing(true);
      setTimeout(() => {
        onComplete();
        // Reload the page to show the newly created demo data
        window.location.reload();
      }, 300);
    } catch (error) {
      console.error("Error setting up demo data:", error);
      setIsLoading(false);
      setLoadingOption(null);
    }
  };

  const handleSelectLLMKey = async () => {
    if (isLoading) return;

    setIsLoading(true);
    setLoadingOption("key");

    try {
      if (organizationId) {
        await updateOnboardingStatus(organizationId);
      }

      dispatch(setOnboardingStatus("completed"));

      setIsClosing(true);
      setTimeout(() => {
        onComplete({ destination: LLM_KEY_CREATE_PATH });
      }, 300);
    } catch (error) {
      console.error("Error completing setup:", error);
      setIsLoading(false);
      setLoadingOption(null);
    }
  };

  const handleSelectBlank = async () => {
    if (isLoading) return;

    setIsLoading(true);
    setLoadingOption("blank");

    try {
      // Update onboarding status to completed (no demo data)
      if (organizationId) {
        await updateOnboardingStatus(organizationId);
      }

      // Update Redux state so it persists after reload
      dispatch(setOnboardingStatus("completed"));

      setIsClosing(true);
      setTimeout(() => {
        onComplete();
      }, 300);
    } catch (error) {
      console.error("Error completing setup:", error);
      setIsLoading(false);
      setLoadingOption(null);
    }
  };

  return (
    <Box
      className="confirmation-backdrop"
      sx={{
        "position": "fixed",
        "top": 0,
        "left": 0,
        "right": 0,
        "bottom": 0,
        "backgroundColor": "rgba(0, 0, 0, 0.4)",
        "backdropFilter": "blur(2px)",
        "display": "flex",
        "alignItems": "center",
        "justifyContent": "center",
        "zIndex": 9999,
        "padding": 2,
        "animation": isClosing ? "fadeOut 0.3s ease-out" : "fadeIn 0.3s ease-in",
        "@keyframes fadeOut": {
          from: { opacity: 1 },
          to: { opacity: 0 },
        },
        "@keyframes fadeIn": {
          from: { opacity: 0 },
          to: { opacity: 1 },
        },
      }}
      onClick={(e) => {
        // Only close on backdrop click, not on modal content click
        if (e.target === e.currentTarget && !isLoading) {
          handleClose();
        }
      }}
    >
      <Box
        role="dialog"
        aria-modal="true"
        sx={{
          backgroundColor: "white",
          borderRadius: "12px",
          boxShadow: "0 20px 60px rgba(0, 0, 0, 0.2)",
          width: "100%",
          maxWidth: "520px",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <Stack
          sx={{
            padding: "32px 32px 24px",
            textAlign: "center",
          }}
        >
          <Typography
            sx={{
              fontSize: 22,
              fontWeight: 600,
              color: "#101828",
              marginBottom: "8px",
            }}
          >
            Welcome to VerifyWise
          </Typography>
          <Typography
            sx={{
              fontSize: 14,
              color: `${text.tertiary}`,
              lineHeight: 1.5,
            }}
          >
            How would you like to get started? You can explore with sample data or begin with a
            clean slate.
          </Typography>
        </Stack>

        {/* Options */}
        <Stack
          spacing={2}
          sx={{
            padding: "0 32px 32px",
          }}
        >
          <Stack direction="row" spacing={4}>
            {/* Demo Data Option */}
            <Box
              onClick={handleSelectDemo}
              sx={{
                "flex": 1,
                "padding": "24px 20px",
                "border": "1px solid #E0E4E9",
                "borderRadius": "4px",
                "cursor": isLoading ? "not-allowed" : "pointer",
                "opacity": isLoading && loadingOption !== "demo" ? 0.5 : 1,
                "transition": "all 0.2s ease",
                "&:hover": {
                  borderColor: isLoading ? "#E0E4E9" : `${brand.primary}`,
                  backgroundColor: isLoading ? "transparent" : "#F8FDFB",
                },
              }}
            >
              <Stack alignItems="center" spacing={2}>
                <Box
                  sx={{
                    width: 48,
                    height: 48,
                    borderRadius: "8px",
                    backgroundColor: "#E8F5F1",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {loadingOption === "demo" ? (
                    <CircularProgress size={24} sx={{ color: `${brand.primary}` }} />
                  ) : (
                    <Database size={24} color={brand.primary} />
                  )}
                </Box>
                <Stack spacing={0.5} alignItems="center">
                  <Typography
                    sx={{
                      fontSize: 15,
                      fontWeight: 600,
                      color: "#101828",
                    }}
                  >
                    Add demo data
                  </Typography>
                  <Typography
                    sx={{
                      fontSize: 13,
                      color: `${text.tertiary}`,
                      textAlign: "center",
                      lineHeight: 1.4,
                    }}
                  >
                    Explore with sample projects and controls
                  </Typography>
                </Stack>
              </Stack>
            </Box>

            {/* Blank Dashboard Option */}
            <Box
              onClick={handleSelectBlank}
              sx={{
                "flex": 1,
                "padding": "24px 20px",
                "border": "1px solid #E0E4E9",
                "borderRadius": "4px",
                "cursor": isLoading ? "not-allowed" : "pointer",
                "opacity": isLoading && loadingOption !== "blank" ? 0.5 : 1,
                "transition": "all 0.2s ease",
                "&:hover": {
                  borderColor: isLoading ? "#E0E4E9" : `${brand.primary}`,
                  backgroundColor: isLoading ? "transparent" : "#F8FDFB",
                },
              }}
            >
              <Stack alignItems="center" spacing={2}>
                <Box
                  sx={{
                    width: 48,
                    height: 48,
                    borderRadius: "8px",
                    backgroundColor: "#F3F5F8",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {loadingOption === "blank" ? (
                    <CircularProgress size={24} sx={{ color: `${text.tertiary}` }} />
                  ) : (
                    <LayoutDashboard size={24} color={text.tertiary} />
                  )}
                </Box>
                <Stack spacing={0.5} alignItems="center">
                  <Typography
                    sx={{
                      fontSize: 15,
                      fontWeight: 600,
                      color: "#101828",
                    }}
                  >
                    Start blank
                  </Typography>
                  <Typography
                    sx={{
                      fontSize: 13,
                      color: `${text.tertiary}`,
                      textAlign: "center",
                      lineHeight: 1.4,
                    }}
                  >
                    Begin with a clean dashboard
                  </Typography>
                </Stack>
              </Stack>
            </Box>
          </Stack>

          {/* Optional LLM key — does not replace demo data or a blank start */}
          <Box
            onClick={handleSelectLLMKey}
            sx={{
              "padding": "16px 20px",
              "border": `1px solid ${border.dark}`,
              "borderRadius": "4px",
              "cursor": isLoading ? "not-allowed" : "pointer",
              "opacity": isLoading && loadingOption !== "key" ? 0.5 : 1,
              "transition": "all 0.2s ease",
              "&:hover": {
                borderColor: isLoading ? border.dark : brand.primary,
                backgroundColor: isLoading ? "transparent" : brand.primaryLight,
              },
            }}
          >
            <Stack direction="row" alignItems="center" spacing={4}>
              <Box
                sx={{
                  width: 40,
                  height: 40,
                  borderRadius: "8px",
                  backgroundColor: status.success.bg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {loadingOption === "key" ? (
                  <CircularProgress size={20} sx={{ color: status.success.text }} />
                ) : (
                  <Key size={20} color={status.success.text} />
                )}
              </Box>
              <Stack spacing={0.25}>
                <Typography
                  sx={{
                    fontSize: fontSize.lg,
                    fontWeight: fontWeight.medium,
                    color: text.primary,
                  }}
                >
                  Add an LLM key
                </Typography>
                <Typography
                  sx={{
                    fontSize: fontSize.base,
                    color: `${text.tertiary}`,
                  }}
                >
                  Optional. Advisor, reporting, and LLM evals need an API key.
                </Typography>
              </Stack>
            </Stack>
          </Box>
        </Stack>

        {/* Footer */}
        <Box
          sx={{
            padding: "16px 32px",
            borderTop: "1px solid #E0E4E9",
            backgroundColor: `${background.accent}`,
          }}
        >
          <Stack direction="row" justifyContent="flex-end">
            <CustomizableButton
              variant="text"
              text="Skip for now"
              onClick={handleClose}
              isDisabled={isLoading}
              sx={{
                "color": `${text.tertiary}`,
                "fontSize": 13,
                "&:hover": {
                  backgroundColor: "transparent",
                  color: "#101828",
                },
              }}
            />
          </Stack>
        </Box>
      </Box>
    </Box>
  );
};

export default SetupModal;
