sap.ui.define(
  [
    "./BaseController",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/m/Text",
    "sap/m/library",
    "sap/m/Dialog",
    "sap/m/Label",
    "sap/m/TextArea",
    "sap/m/Button",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/core/BusyIndicator",
    "../lib/xlsx.full.min",
    "../lib/FileSaver.min"
  ],
  function (
    BaseController,
    MessageBox,
    MessageToast,
    Text,
    mobileLibrary,
    Dialog,
    Label,
    TextArea,
    Button,
    JSONModel,
    Filter,
    FilterOperator,
    BusyIndicator
  ) {
    "use strict";

    var ButtonType = mobileLibrary.ButtonType;

    return BaseController.extend(
      "com.intapptics.zmdrbulkapprover.controller.BulkApprover",
      {
        self: undefined,
        categoryName: undefined,
        tableName: undefined,
        TableName: undefined,
        futureVer: "N",
        Versioned: "N",
        role: undefined,
        Requesterrole: undefined,
        isOverwrtwithnull: "N",
        updatezflag: "N",
        remarks: undefined,
        ReqEmailId: undefined,
        RequesterId: undefined,
        requesterName: undefined,
        approveemail: undefined,
        approverremarks: undefined,
        approvallevel: "0",
        workflowId: undefined,
        tableDesc: undefined,

        onInit: function () {
          var self = this;
          this.self = self;
          self.oView = this.getView();

          // Attach router pattern matched matching Central pattern
          if (this.getRouter() && this.getRouter().getRoute("main")) {
            this.getRouter().getRoute("main").attachPatternMatched(this._onObjectMatched, this);
          }

          // Subscribe to SeeChanges event from My Inbox
          var oOwnerComp = this.getOwnerComponent();
          if (oOwnerComp && oOwnerComp.getEventBus) {
              oOwnerComp.getEventBus().subscribe("BulkApprover", "SeeChanges", this.handleDownloadPress, this);
          }

          // Initial check
          this._onObjectMatched();
        },

        onExit: function () {
          var oOwnerComp = this.getOwnerComponent();
          if (oOwnerComp && oOwnerComp.getEventBus) {
              oOwnerComp.getEventBus().unsubscribe("BulkApprover", "SeeChanges", this.handleDownloadPress, this);
          }
        },

        _onObjectMatched: async function (oEvent) {
          var self = this;
          var oComponent = this.getOwnerComponent();
          var oComponentData = oComponent ? oComponent.getComponentData() : null;
          var params = oComponentData ? oComponentData.startupParameters : null;

          var sWorkflowId = "";
          var sTablename = "";
          var sRequesterId = "";
          var sReqEmailId = "";
          var sRequesterName = "";
          var sRemarks = "";
          var sCategory = "";
          var sTableDesc = "";
          var sApprovalLevel = "0";

          // 1. Check URL / FLP startup parameters
          if (params) {
            if (params.sWorkflowID && params.sWorkflowID[0]) {
              sWorkflowId = params.sWorkflowID[0];
            } else if (params.workflowId && params.workflowId[0]) {
              sWorkflowId = params.workflowId[0];
            } else if (params.workflowid && params.workflowid[0]) {
              sWorkflowId = params.workflowid[0];
            }
            if (params.sTablename && params.sTablename[0]) {
              sTablename = params.sTablename[0];
            } else if (params.tableName && params.tableName[0]) {
              sTablename = params.tableName[0];
            } else if (params.tablename && params.tablename[0]) {
              sTablename = params.tablename[0];
            }
            if (params.sRequestorName && params.sRequestorName[0]) {
              sRequesterName = params.sRequestorName[0];
            } else if (params.requestorName && params.requestorName[0]) {
              sRequesterName = params.requestorName[0];
            } else if (params.requesterName && params.requesterName[0]) {
              sRequesterName = params.requesterName[0];
            }
            if (params.sRequestorID && params.sRequestorID[0]) {
              sRequesterId = params.sRequestorID[0];
            } else if (params.requestorId && params.requestorId[0]) {
              sRequesterId = params.requestorId[0];
            } else if (params.requesterId && params.requesterId[0]) {
              sRequesterId = params.requesterId[0];
            }
            if (params.sRequestorEmail && params.sRequestorEmail[0]) {
              sReqEmailId = params.sRequestorEmail[0];
            } else if (params.requestorEmail && params.requestorEmail[0]) {
              sReqEmailId = params.requestorEmail[0];
            } else if (params.requesterEmail && params.requesterEmail[0]) {
              sReqEmailId = params.requesterEmail[0];
            }
            if (params.sRemarks && params.sRemarks[0]) {
              sRemarks = params.sRemarks[0];
            } else if (params.userRemarks && params.userRemarks[0]) {
              sRemarks = params.userRemarks[0];
            } else if (params.remarks && params.remarks[0]) {
              sRemarks = params.remarks[0];
            }
          }

          // 2. Read BPA My Inbox Task Context (async promise from Component.js)
          if (oComponent && oComponent.contextLoaded) {
            try {
              await oComponent.contextLoaded;
              var oContextModel = oComponent.getModel("context");
              if (oContextModel) {
                var oCtx = oContextModel.getData() || {};
                sWorkflowId = sWorkflowId || oCtx.sWorkflowID || oCtx.workflowId || oCtx.WorkflowId || oCtx.workflowID || oCtx.workflowid || "";
                sTablename = sTablename || oCtx.sTablename || oCtx.tableName || oCtx.TableName || oCtx.tablename || "";
                sRequesterId = sRequesterId || oCtx.sRequestorID || oCtx.sRequesterID || oCtx.requestorId || oCtx.RequestorId || oCtx.RequesterId || oCtx.requesterId || oCtx.requestorid || oCtx.requesterid || "";
                sReqEmailId = sReqEmailId || oCtx.sRequestorEmail || oCtx.sRequesterEmail || oCtx.requestorEmail || oCtx.RequestorEmail || oCtx.ReqEmailId || oCtx.reqEmailId || oCtx.requesterEmail || oCtx.RequesterEmail || oCtx.requestoremail || oCtx.requesteremail || "";
                sRequesterName = sRequesterName || oCtx.sRequestorName || oCtx.sRequesterName || oCtx.requestorName || oCtx.RequestorName || oCtx.requesterName || oCtx.RequesterName || oCtx.requestorname || oCtx.requestername || "";
                sRemarks = sRemarks || oCtx.sRemarks || oCtx.userRemarks || oCtx.UserRemarks || oCtx.remarks || oCtx.Remarks || oCtx.userremarks || "";
                sCategory = sCategory || oCtx.category || oCtx.Category || "";
                sTableDesc = sTableDesc || oCtx.tableDesc || oCtx.Tabledesc || oCtx.entityName || "";
                sApprovalLevel = sApprovalLevel || oCtx.approverLevel || oCtx.ApproverLevel || oCtx.approverStage || "0";
              }
            } catch (e) {
              console.warn("[BulkApprover] Could not load task context:", e);
            }
          }

          // 3. Fallback: If any metadata is missing, auto-recover from WFAudit via OData V4 Model
          if (sWorkflowId && (!sTablename || !sRequesterId || !sRemarks || !sReqEmailId || !sRequesterName)) {
            try {
              var oModel = oComponent ? oComponent.getModel() : null;
              if (oModel) {
                var oAuditBinding = oModel.bindList("/WFAudit", null, null, [new Filter("WorkflowId", FilterOperator.EQ, sWorkflowId)]);
                var aAuditContexts = await oAuditBinding.requestContexts(0, 50);
                if (aAuditContexts && aAuditContexts.length > 0) {
                  var aAudits = aAuditContexts.map(function (c) { return c.getObject(); });
                  var oInitAudit = aAudits.find(function (a) {
                    var act = (a.Action || a.action || "").toUpperCase();
                    var stg = (a.WfStage || a.wfstage || "").toUpperCase();
                    return act === "INITIATED" || stg === "INITIATOR";
                  }) || aAudits[0];

                  sTablename = sTablename || oInitAudit.EntityName || oInitAudit.entityname || "";
                  sRequesterId = sRequesterId || oInitAudit.ActioningUser || oInitAudit.actioninguser || "";
                  sRemarks = sRemarks || oInitAudit.UserRemarks || oInitAudit.userremarks || "";
                  if (!sReqEmailId && sRequesterId && sRequesterId.indexOf("@") !== -1) {
                    sReqEmailId = sRequesterId;
                  }
                  if (!sRequesterName && sRequesterId) {
                    sRequesterName = sRequesterId;
                  }
                }

                if (!sTablename) {
                  var oTempBinding = oModel.bindList("/BulkTemp", null, null, [new Filter("WorkflowId", FilterOperator.EQ, sWorkflowId)]);
                  var aTempContexts = await oTempBinding.requestContexts(0, 10);
                  if (aTempContexts && aTempContexts.length > 0) {
                    var aTemps = aTempContexts.map(function (c) { return c.getObject(); });
                    sTablename = aTemps[0].Tablename || aTemps[0].tablename || "";
                  }
                }
              }
            } catch (err) {
              console.warn("[BulkApprover] Auto-recovery via OData V4 failed:", err);
            }
          }

          var isGuid = function (str) {
            return !str || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(str).trim());
          };

          // Dynamic clean requester resolution
          if (isGuid(sRequesterName)) {
            if (sReqEmailId) {
              var localPart = sReqEmailId.split("@")[0];
              sRequesterName = localPart.split(/[._-]/).map(function (s) { return s.charAt(0).toUpperCase() + s.slice(1); }).join(" ");
            } else if (!isGuid(sRequesterId)) {
              sRequesterName = sRequesterId;
            }
          }

          if (isGuid(sRequesterId) && sReqEmailId) {
            sRequesterId = sReqEmailId;
          }

          if (!sRequesterId && sRequesterName) sRequesterId = sRequesterName;
          if (!sRequesterName && sRequesterId) sRequesterName = sRequesterId;
          if (!sReqEmailId && sRequesterId && sRequesterId.indexOf("@") !== -1) {
            sReqEmailId = sRequesterId;
          }
          if (!sTableDesc) sTableDesc = sTablename;

          self.workflowId = sWorkflowId;
          self.TableName = sTablename;
          self.tableName = sTablename;
          self.RequesterId = sRequesterId;
          self.ReqEmailId = sReqEmailId;
          self.requesterName = sRequesterName;
          self.remarks = sRemarks;
          self.categoryName = sCategory;
          self.tableDesc = sTableDesc || sTablename;
          self.approvallevel = sApprovalLevel;

          // Reactive JSONModel data-binding for all header and requester fields
          var oHeaderData = {
            WorkflowId: self.workflowId || "",
            TableName: self.tableName || "",
            TableDesc: self.tableDesc || self.tableName || "",
            Category: self.categoryName || "",
            RequesterId: self.RequesterId || "",
            ReqEmailId: self.ReqEmailId || "",
            RequesterName: self.requesterName || "",
            Remarks: self.remarks || ""
          };
          var oHeaderModel = self.getView().getModel("header");
          if (!oHeaderModel) {
            oHeaderModel = new JSONModel(oHeaderData);
            self.getView().setModel(oHeaderModel, "header");
          } else {
            oHeaderModel.setData(oHeaderData);
          }

          // Direct text updates for immediate rendering
          if (self.workflowId) self.getView().byId("txt_wfid")?.setText(self.workflowId);
          if (self.tableName) self.getView().byId("txt_table")?.setText(self.tableName);
          if (self.tableDesc) self.getView().byId("txt_tabledesc")?.setText(self.tableDesc);
          if (self.categoryName) self.getView().byId("txt_category")?.setText(self.categoryName);
          if (self.RequesterId) self.getView().byId("txt_reqid")?.setText(self.RequesterId);
          if (self.ReqEmailId) self.getView().byId("txt_reqemail")?.setText(self.ReqEmailId);
          if (self.requesterName) self.getView().byId("txt_reqname")?.setText(self.requesterName);
          if (self.remarks) self.getView().byId("txt_reqremarks")?.setText(self.remarks);

          self.getView().byId("form_bulkappr")?.setVisible(true);
          self.getView().byId("btn_approve")?.setVisible(true);
          self.getView().byId("btn_reject")?.setVisible(true);

          // 3. Load extra Table / Workflow configuration via OData V4 endpoint
          if (self.tableName) {
            self._loadTableConfigV4(self.tableName);
          }
        },

        _getServiceUrl: function () {
          try {
            var sPrefix = sap.ui.require.toUrl("com/intapptics/zmdrbulkapprover");
            if (sPrefix && sPrefix !== "." && !sPrefix.startsWith(".")) {
              return sPrefix.endsWith("/") ? sPrefix + "mdrapi/bulk/" : sPrefix + "/mdrapi/bulk/";
            }
          } catch (e) {}
          var oModel = this.getOwnerComponent() ? this.getOwnerComponent().getModel() : null;
          if (oModel && typeof oModel.getServiceUrl === "function") {
            var url = oModel.getServiceUrl();
            return url.endsWith("/") ? url : url + "/";
          }
          return "/mdrapi/bulk/";
        },

        _fetchCsrfToken: function () {
          var self = this;
          return new Promise(function (resolve) {
            var sUrl = self._getServiceUrl();
            jQuery.ajax({
              url: sUrl,
              method: "GET",
              headers: {
                "X-CSRF-Token": "Fetch"
              },
              success: function (data, textStatus, request) {
                var sToken = request.getResponseHeader("X-CSRF-Token");
                resolve(sToken);
              },
              error: function (err) {
                resolve(""); // Fallback for local dev or if CSRF is disabled
              }
            });
          });
        },

        _loadTableConfigV4: async function (sTableName) {
          var self = this;
          var oComponent = self.getOwnerComponent();
          var oModel = oComponent ? oComponent.getModel() : null;

          if (oModel) {
            try {
              var oBinding = oModel.bindList("/BulkHdrConfig", null, null, [new Filter("TableName", FilterOperator.EQ, sTableName)]);
              var aContexts = await oBinding.requestContexts(0, 10);
              if (aContexts && aContexts.length > 0) {
                var oHdr = aContexts[0].getObject();
                self.Versioned = oHdr.Versioned || oHdr.isversioned || "N";
                self.isOverwrtwithnull = oHdr.IsOverwrireWithNull || "N";
                if (oHdr.Category && !self.categoryName) {
                  self.categoryName = oHdr.Category;
                  self.getView().byId("txt_category")?.setText(oHdr.Category);
                }
                if (oHdr.Description && !self.tableDesc) {
                  self.tableDesc = oHdr.Description;
                  self.getView().byId("txt_tabledesc")?.setText(oHdr.Description);
                }
                return;
              }
            } catch (err) {
              console.warn("[BulkApprover] Table config OData V4 query fallback:", err);
            }
          }

          var sUrl = self._getServiceUrl() + "BulkHdrConfig?$filter=TableName eq '" + encodeURIComponent(sTableName) + "'";

          jQuery.ajax({
            url: sUrl,
            method: "GET",
            dataType: "json",
            headers: {
              "Accept": "application/json"
            },
            success: function (oData) {
              var aResults = oData && (oData.value || oData.d?.results || oData.d);
              if (aResults && aResults.length > 0) {
                var oHdr = aResults[0];
                self.Versioned = oHdr.Versioned || oHdr.isversioned || "N";
                self.isOverwrtwithnull = oHdr.IsOverwrireWithNull || "N";
                if (oHdr.Category && !self.categoryName) {
                  self.categoryName = oHdr.Category;
                  self.getView().byId("txt_category")?.setText(oHdr.Category);
                }
                if (oHdr.Description && !self.tableDesc) {
                  self.tableDesc = oHdr.Description;
                  self.getView().byId("txt_tabledesc")?.setText(oHdr.Description);
                }
              }
            },
            error: function (err) {
              console.warn("[BulkApprover] Table config query skipped/fallback:", err);
            }
          });
        },

        putBackWorkItem: function () {
          var self = this;
          var oComponent = self.getOwnerComponent();
          if (oComponent && typeof oComponent.getInboxAPI === "function" && oComponent.getInboxAPI()) {
            var sTaskId = typeof oComponent.getTaskInstanceID === "function" ? oComponent.getTaskInstanceID() : "";
            oComponent.getInboxAPI().updateTask("NA", sTaskId);
            MessageToast.show("Work item returned to pool.");
          } else {
            MessageToast.show("Task putback processed.");
          }
        },

        handleDownloadPress: function () {
          var self = this;
          var currentDate = new Date();
          var sDateTime =
            currentDate.getFullYear() +
            ("0" + (currentDate.getMonth() + 1)).slice(-2) +
            ("0" + currentDate.getDate()).slice(-2) +
            "_" +
            ("0" + currentDate.getHours()).slice(-2) +
            ("0" + currentDate.getMinutes()).slice(-2) +
            ("0" + currentDate.getSeconds()).slice(-2);

          var sWorkflowId = self.workflowId;
          
          if (!sWorkflowId || sWorkflowId === "undefined") {
            MessageBox.warning("Session context lost. Please select the task again from the left panel in My Inbox.");
            return;
          }

          var sTableName = self.TableName || self.tableName;
          var sVersion = self.Versioned === "Y" ? (self.futureVer === "Y" ? "F" : "G") : "G";

          BusyIndicator.show(0);

          self._fetchCsrfToken().then(function(sToken) {
            var sActionUrl = self._getServiceUrl();
            if (sActionUrl.endsWith("/")) {
              sActionUrl = sActionUrl.slice(0, -1);
            }
            sActionUrl = sActionUrl + "/rest/getBulkRequestData";
            var oPayload = {
              tablename: sTableName,
              workflowid: sWorkflowId,
              versionactive: sVersion,
              wfstage: self.approvallevel === "0" || !self.approvallevel ? "APPROVER" : self.approvallevel,
              action: "",
              requesterrole: self.role || "",
              uniquewf: "N"
            };

            jQuery.ajax({
              url: sActionUrl,
              method: "POST",
              contentType: "application/json",
              data: JSON.stringify(oPayload),
              headers: {
                "Accept": "application/json",
                "X-CSRF-Token": sToken || ""
              },
              success: function (oData) {
                BusyIndicator.hide();
                var aRows = (oData && oData.data) || (oData && oData.value && oData.value.data) || [];

                if (!aRows || aRows.length === 0) {
                  // Fallback: Query BulkTemp entity set directly
                  self._downloadFromBulkTempV4(sTableName, sWorkflowId, sDateTime);
                  return;
                }

                var wsData = [];
                for (var i = 0; i < aRows.length; i++) {
                  var rowStr = aRows[i].data || aRows[i].Data || "";
                  wsData.push(rowStr.split("«"));
                }

                self._exportToExcel(wsData, sTableName, sWorkflowId, sDateTime);
              },
              error: function (oError) {
                BusyIndicator.hide();
                console.warn("[BulkApprover] getBulkRequestData action failed, trying BulkTemp fallback:", oError);
                console.error("[BulkApprover] Server error response:", oError.responseText || oError.statusText);
                console.error("[BulkApprover] HTTP status:", oError.status);
                self._downloadFromBulkTempV4(sTableName, sWorkflowId, sDateTime);
              }
            });
          });
        },

        _downloadFromBulkTempV4: async function (sTableName, sWorkflowId, sDateTime) {
          var self = this;
          var oComponent = self.getOwnerComponent();
          var oModel = oComponent ? oComponent.getModel() : null;

          BusyIndicator.show(0);

          if (oModel) {
            try {
              var oBinding = oModel.bindList("/BulkTemp", null, null, [new Filter("WorkflowId", FilterOperator.EQ, sWorkflowId)]);
              var aContexts = await oBinding.requestContexts(0, 1000);
              if (aContexts && aContexts.length > 0) {
                BusyIndicator.hide();
                var aResults = aContexts.map(function (c) { return c.getObject(); });
                var wsData = [];
                for (var i = 0; i < aResults.length; i++) {
                  var rowStr = aResults[i].Data || aResults[i].data || "";
                  if (rowStr) {
                    wsData.push(rowStr.split("«"));
                  }
                }
                if (wsData.length > 0) {
                  self._exportToExcel(wsData, sTableName, sWorkflowId, sDateTime);
                  return;
                }
              }
            } catch (e) {
              console.warn("[BulkApprover] Direct BulkTemp OData V4 query fallback:", e);
            }
          }

          var sUrl = self._getServiceUrl() + "BulkTemp?$filter=WorkflowId eq '" + encodeURIComponent(sWorkflowId) + "'";
          jQuery.ajax({
            url: sUrl,
            method: "GET",
            dataType: "json",
            headers: {
              "Accept": "application/json"
            },
            success: function (oData) {
              BusyIndicator.hide();
              var aResults = oData && (oData.value || oData.d?.results || oData.d);
              if (!aResults || aResults.length === 0) {
                MessageBox.information("No records found for workflow " + sWorkflowId);
                return;
              }

              var wsData = [];
              for (var i = 0; i < aResults.length; i++) {
                var rowStr = aResults[i].Data || aResults[i].data || "";
                if (rowStr) {
                  wsData.push(rowStr.split("«"));
                }
              }

              self._exportToExcel(wsData, sTableName, sWorkflowId, sDateTime);
            },
            error: function (err) {
              BusyIndicator.hide();
              MessageBox.error("Failed to load records for workflow: " + sWorkflowId);
            }
          });
        },

        _exportToExcel: function (wsData, sTableName, sWorkflowId, sDateTime) {
          try {
            var XLib = (typeof XLSX_Style !== "undefined") ? XLSX_Style : (typeof XLSX !== "undefined" ? XLSX : null);
            if (!XLib) {
              throw new Error("No XLSX library available. Please ensure xlsx-js-style is loaded.");
            }

            var wb = XLib.utils.book_new();
            wb.Props = {
              Title: sTableName,
              Subject: sTableName,
              Author: "MDR CAP",
              CreationDate: new Date()
            };
            wb.SheetNames.push("Requested Data");
            var ws = XLib.utils.aoa_to_sheet(wsData);
            
            if (wsData && wsData.length > 0 && wsData[0]) {
              var headerRow = wsData[0];
              var columnPairs = [];
              var oldMap = {};
              var newMap = {};
              
              for (var j = 0; j < headerRow.length; j++) {
                var hdr = headerRow[j];
                if (typeof hdr === "string") {
                  if (hdr.startsWith("Old ")) {
                    oldMap[hdr.substring(4)] = j;
                  } else if (hdr.startsWith("New ")) {
                    newMap[hdr.substring(4)] = j;
                  }
                }
              }
              
              var fieldNames = Object.keys(oldMap);
              for (var f = 0; f < fieldNames.length; f++) {
                var fn = fieldNames[f];
                if (newMap[fn] !== undefined) {
                  columnPairs.push({
                    oldIdx: oldMap[fn],
                    newIdx: newMap[fn],
                    fieldName: fn
                  });
                }
              }

              if (columnPairs.length > 0) {
                for (var r = 1; r < wsData.length; r++) {
                  for (var p = 0; p < columnPairs.length; p++) {
                    var pair = columnPairs[p];
                    var oldVal = wsData[r][pair.oldIdx];
                    var newVal = wsData[r][pair.newIdx];
                    
                    var sOld = (oldVal || "").toString().trim();
                    var sNew = (newVal || "").toString().trim();
                    
                    if (sOld !== sNew) {
                      var cellRef = XLib.utils.encode_cell({ r: r, c: pair.newIdx });
                      if (ws[cellRef]) {
                        ws[cellRef].s = {
                          fill: {
                            patternType: "solid",
                            fgColor: { rgb: "FFADD8E6" }
                          },
                          font: {
                            bold: true,
                            color: { rgb: "FF000000" }
                          }
                        };
                      }
                    }
                  }
                }
              }
            }

            wb.Sheets["Requested Data"] = ws;

            var wbout = XLib.write(wb, {
              bookType: "xlsx",
              type: "binary",
              cellStyles: true
            });

            function s2ab(s) {
              var buf = new ArrayBuffer(s.length);
              var view = new Uint8Array(buf);
              for (var i = 0; i < s.length; i++) {
                view[i] = s.charCodeAt(i) & 0xff;
              }
              return buf;
            }

            var sFileName = (sTableName || "BulkRequest") + "_RequestedRecords_" + (sWorkflowId || "") + "_" + sDateTime + ".xlsx";
            saveAs(
              new Blob([s2ab(wbout)], {
                type: "application/octet-stream"
              }),
              sFileName
            );
            MessageToast.show("Excel file downloaded successfully.");
          } catch (e) {
            console.error("[BulkApprover] Excel generation error:", e);
            MessageBox.error("Error generating Excel file: " + e.message);
          }
        },

        onActionButtonPress: function (oEvent) {
          var self = this;
          var sButtonAction = oEvent.getSource().data("buttonAction") || "APPROVED";
          var sDialogTitle = sButtonAction === "APPROVED" || sButtonAction === "Resolve" ? "Approve Request" : "Reject Request";

          var oDialog = new Dialog({
            title: sDialogTitle,
            type: "Message",
            content: [
              new Label({
                text: "Business Justification / Remarks",
                labelFor: "approverDialogTextArea",
                required: true
              }),
              new TextArea("approverDialogTextArea", {
                liveChange: function (ev) {
                  var sText = ev.getParameter("value");
                  var parent = ev.getSource().getParent();
                  parent.getBeginButton().setEnabled(sText.trim().length > 0);
                },
                width: "100%",
                rows: 4,
                placeholder: "Enter remarks (required)...",
                maxLength: 500
              })
            ],
            beginButton: new Button({
              type: sButtonAction === "APPROVED" || sButtonAction === "Resolve" ? ButtonType.Accept : ButtonType.Reject,
              text: "Submit",
              enabled: false,
              press: function () {
                var sRemarks = sap.ui.getCore().byId("approverDialogTextArea").getValue();
                if (!sRemarks || !sRemarks.trim()) {
                  MessageToast.show("Please enter remarks.");
                  return;
                }
                oDialog.close();
                self.handleDialogSubmitPress(self.workflowId, sButtonAction, sRemarks.trim());
              }
            }),
            endButton: new Button({
              text: "Cancel",
              press: function () {
                oDialog.close();
              }
            }),
            afterClose: function () {
              oDialog.destroy();
            }
          });

          oDialog.open();
        },

        handleDialogSubmitPress: function (sWorkflowId, sActionTaken, sRemarks) {
          var self = this;
          var sNormalizedAction = (sActionTaken === "APPROVED" || sActionTaken === "Resolve") ? "APPROVED" : "REJECTED";
          var sVersion = self.Versioned === "Y" ? (self.futureVer === "Y" ? "F" : "G") : "N";

          if (!sWorkflowId || sWorkflowId === "undefined") {
            sWorkflowId = self.workflowId;
          }

          if (!sWorkflowId || sWorkflowId === "undefined") {
            MessageBox.warning("Session context lost. Please select the task again from the left panel in My Inbox.");
            return;
          }

          BusyIndicator.show(0);

          self._fetchCsrfToken().then(function(sToken) {
            var oPayload = {
              tablename: self.TableName || self.tableName,
              workflowid: sWorkflowId,
              wfstage: self.approvallevel === "0" || !self.approvallevel ? "APPROVER" : self.approvallevel,
              action: sNormalizedAction,
              version: sVersion,
              requesterrole: self.role || "",
              bpaInstanceId: "",
              approverremarks: sRemarks,
              isOverwriteNull: self.isOverwrtwithnull || "N"
            };

            var sActionUrl = self._getServiceUrl() + "takeActionBulk";

            jQuery.ajax({
              url: sActionUrl,
              method: "POST",
              contentType: "application/json",
              data: JSON.stringify(oPayload),
              headers: {
                "Accept": "application/json",
                "X-CSRF-Token": sToken || ""
              },
              success: function (oRes) {
                BusyIndicator.hide();

                // If running in BPA My Inbox, complete the BPA task
                var oComponent = self.getOwnerComponent();
                if (oComponent && typeof oComponent.completeTask === "function") {
                  try {
                    oComponent.completeTask(sNormalizedAction === "APPROVED", sNormalizedAction === "APPROVED" ? "approve" : "reject", sRemarks);
                  } catch (e) {
                    console.warn("[BulkApprover] BPA task completion notify:", e);
                  }
                }

                // Update View UI
                self.getView().byId("taskCompletedMsg")?.setVisible(true);
                self.getView().byId("taskCompletedMsg")?.setText("Task completed successfully (" + sNormalizedAction + ")");
                self.getView().byId("tb_footerbulkappr")?.setVisible(false);
                self.getView().byId("form_bulkappr")?.setVisible(false);
                self.getView().byId("btn_putback")?.setVisible(false);

                MessageBox.success("Action " + sNormalizedAction + " submitted successfully for Workflow " + sWorkflowId);
              },
              error: function (err) {
                BusyIndicator.hide();
                console.error("[BulkApprover] takeActionBulk failed:", err);
                var sErrorMsg = err.responseText || err.message || "Action could not be completed";
                try {
                  var oErrJson = JSON.parse(err.responseText);
                  if (oErrJson?.error?.message) sErrorMsg = oErrJson.error.message;
                } catch (e) {}
                MessageBox.error(sErrorMsg);
              }
            });
          });
        },

        handleReloadPress: function () {
          window.location.reload();
        },

        fn_showBusyIndicator: function () {
          BusyIndicator.show(0);
        },

        fn_closeBusyIndicator: function () {
          BusyIndicator.hide();
        }
      }
    );
  }
);