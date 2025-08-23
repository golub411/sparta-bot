// CryptoCloudSDK.js
class CryptoCloudSDK {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = "https://api.cryptocloud.plus/v2/";
  }

  async sendRequest(endpoint, method = "POST", payload = null) {
    const headers = {
      Authorization: `Token ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    const url = this.baseUrl + endpoint;

    const response = await fetch(url, {
      method: method,
      headers: headers,
      body: payload ? JSON.stringify(payload) : null,
    });

    return response.json();
  }

  createInvoice(invoiceData) {
    return this.sendRequest("invoice/create", "POST", invoiceData);
  }

  cancelInvoice(uuid) {
    return this.sendRequest("invoice/merchant/canceled", "POST", { uuid });
  }

  listInvoices(startDate, endDate, offset = 0, limit = 10) {
    return this.sendRequest("invoice/merchant/list", "POST", {
      start: startDate,
      end: endDate,
      offset,
      limit,
    });
  }

  getInvoiceInfo(uuids) {
    return this.sendRequest("invoice/merchant/info", "POST", { uuids });
  }

  getBalance() {
    return this.sendRequest("merchant/wallet/balance/all", "POST");
  }

  getStatistics(startDate, endDate) {
    return this.sendRequest("invoice/merchant/statistics", "POST", {
      start: startDate,
      end: endDate,
    });
  }
}

module.exports = CryptoCloudSDK;