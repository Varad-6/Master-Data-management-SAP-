sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "sap/m/MessageBox"
], (Controller, MessageToast, MessageBox) => {
    "use strict";

    return Controller.extend("com.intapptics.zmdradminconsole.controller.Main", {
        onInit() {
        },

        _getFormData: function () {
            var oView = this.getView();
            return {
                applicationType: oView.byId("appTypeGroup").getSelectedButton().getText(),
                entityType: oView.byId("entityTypeCombo").getSelectedKey(),
                entityNumber: oView.byId("entityNumberInput").getValue(),
                workflowId: oView.byId("workflowIdInput").getValue().trim(),
                remarks: oView.byId("remarksTextArea").getValue().trim()
            };
        },

        _validateForm: function (oData) {
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            if (!oData.workflowId) {
                MessageBox.error(oBundle.getText("msgWorkflowIdRequired"));
                return false;
            }
            if (!oData.remarks) {
                MessageBox.error(oBundle.getText("msgRemarksRequired"));
                return false;
            }
            return true;
        },

        _clearForm: function () {
            var oView = this.getView();
            oView.byId("workflowIdInput").setValue("");
            oView.byId("remarksTextArea").setValue("");
            oView.byId("entityNumberInput").setValue("");
        },

        _executeAction: function (sAction) {
            var oView = this.getView();
            var oBundle = oView.getModel("i18n").getResourceBundle();
            var oData = this._getFormData();

            var oModel = oView.getModel();
            var oActionBinding = oModel.bindContext("/adminApproveRejectWorkflow(...)");
            oActionBinding.setParameter("applicationType", oData.applicationType);
            oActionBinding.setParameter("entityType", oData.entityType);
            oActionBinding.setParameter("entityNumber", oData.entityNumber);
            oActionBinding.setParameter("workflowId", oData.workflowId);
            oActionBinding.setParameter("remarks", oData.remarks);
            oActionBinding.setParameter("action", sAction);

            oView.setBusy(true);
            var that = this;

            oActionBinding.execute().then(function () {
                var oContext = oActionBinding.getBoundContext();
                var oResult = oContext.getObject();
                oView.setBusy(false);
                if (oResult.success) {
                    MessageBox.success(
                        oResult.message || oBundle.getText("msgActionSuccess", [oData.workflowId, sAction + "D"]),
                        { title: "Success" }
                    );
                    that._clearForm();
                } else {
                    MessageBox.error(oResult.message || oBundle.getText("msgActionFailed"));
                }
            }).catch(function (oError) {
                oView.setBusy(false);
                MessageBox.error(oError.message || oBundle.getText("msgErrorOccurred"));
            });
        },

        _confirmAndExecute: function (sAction) {
            var oData = this._getFormData();
            if (!this._validateForm(oData)) {
                return;
            }

            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            var sMsgKey = sAction === "APPROVE" ? "msgConfirmApprove" : "msgConfirmReject";
            var sConfirmMsg = oBundle.getText(sMsgKey, [oData.workflowId]);
            var that = this;

            MessageBox.confirm(sConfirmMsg, {
                title: oBundle.getText("msgConfirmTitle"),
                emphasizedAction: MessageBox.Action.OK,
                onClose: function (sButton) {
                    if (sButton === MessageBox.Action.OK) {
                        that._executeAction(sAction);
                    }
                }
            });
        },

        onApprove: function () {
            this._confirmAndExecute("APPROVE");
        },

        onReject: function () {
            this._confirmAndExecute("REJECT");
        }
    });
});