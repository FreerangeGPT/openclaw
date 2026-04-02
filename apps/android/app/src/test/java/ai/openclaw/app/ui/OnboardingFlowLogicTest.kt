package ai.openclaw.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OnboardingFlowLogicTest {
  @Test
  fun blocksFinishWhenOnlyOperatorIsConnected() {
    assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = false))
  }

  @Test
  fun blocksFinishWhenDisconnected() {
    assertFalse(canFinishOnboarding(isConnected = false, isNodeConnected = false))
  }

  @Test
  fun blocksFinishWhenOnlyNodeIsConnected() {
    assertFalse(canFinishOnboarding(isConnected = false, isNodeConnected = true))
  }

  @Test
  fun allowsFinishOnlyWhenOperatorAndNodeAreConnected() {
    assertTrue(canFinishOnboarding(isConnected = true, isNodeConnected = true))
  }

  @Test
  fun waitsForOperatorApprovalAfterNodeConnect() {
    assertTrue(
      isWaitingForOperatorApproval(
        statusText = "Connected (awaiting operator approval)",
        isConnected = false,
        isNodeConnected = true,
        attemptedConnect = true,
      ),
    )
  }

  @Test
  fun doesNotWaitForApprovalBeforeConnectAttempt() {
    assertFalse(
      isWaitingForOperatorApproval(
        statusText = "Connected (awaiting operator approval)",
        isConnected = false,
        isNodeConnected = true,
        attemptedConnect = false,
      ),
    )
  }

  @Test
  fun autoFinishesAfterSuccessfulReconnect() {
    assertTrue(shouldAutoFinishOnboarding(attemptedConnect = true, canFinishOnboarding = true))
    assertFalse(shouldAutoFinishOnboarding(attemptedConnect = false, canFinishOnboarding = true))
  }
}
