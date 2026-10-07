import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useState } from "react";
import { Dialog } from "@agentkib/conversation-ui/components/dialog";
afterEach(cleanup);
it("returns to the stable session action trigger after replacing a dialog", async () => {
  function View() {
    const [step, setStep] = useState(0);
    return (
      <>
        <button data-dialog-return-focus="true" onClick={() => setStep(1)}>
          会话操作
        </button>
        {step === 1 && (
          <Dialog panel title="操作" closeLabel="关闭" onClose={() => setStep(0)}>
            <button onClick={() => setStep(2)}>偏好</button>
          </Dialog>
        )}
        {step === 2 && (
          <Dialog title="偏好" closeLabel="关闭" onClose={() => setStep(0)}>
            设置内容
          </Dialog>
        )}
      </>
    );
  }
  render(<View />);
  screen.getByRole("button", { name: "会话操作" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
  screen.getByRole("button", { name: "偏好" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "偏好" }));
  await waitFor(() =>
    expect(screen.getByRole("dialog", { name: "偏好" })).toContainElement(
      document.activeElement as HTMLElement,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "会话操作" })).toHaveFocus());
});
